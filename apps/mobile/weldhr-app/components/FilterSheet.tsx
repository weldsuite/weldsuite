/**
 * A filter as a bottom sheet, after Shiftbase's: "Filter" large on the left,
 * "Enable all" (or, with everything on, "Disable all") on the right, a switch
 * per option and a wide Apply button. Every option starts on; one switched
 * off hides its rows once applied. The switches are a draft until Apply, so
 * closing the sheet changes nothing.
 */

import { useState } from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { Button } from '@weldsuite/mobile-ui/components/Button';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';

import { usePalette } from '@/hooks/use-palette';
import { toggled } from '@/lib/expense-filter';
import { useI18n } from '@/lib/i18n';
import { SwipeSheet } from './SwipeSheet';

export interface FilterOption<T extends string> {
  value: T;
  label: string;
}

export function FilterSheet<T extends string>({
  options,
  off,
  onApply,
  onClose,
}: Readonly<{
  options: FilterOption<T>[];
  /** The options switched off now. */
  off: T[];
  onApply: (off: T[]) => void;
  onClose: () => void;
}>) {
  const palette = usePalette();
  const { colors } = useTheme();
  const { t } = useI18n();
  const [draft, setDraft] = useState(off);
  const allOn = draft.length === 0;

  return (
    <SwipeSheet onClose={onClose}>
      {(close) => (
        <>
          <View style={styles.header}>
            <Text style={[styles.title, { color: palette.text }]} accessibilityRole="header">
              {t.common.filter}
            </Text>
            <Pressable
              onPress={() => setDraft(allOn ? options.map((option) => option.value) : [])}
              hitSlop={10}
              accessibilityRole="button"
              testID="filter-all"
            >
              {({ pressed }) => (
                <Text style={[styles.all, { color: palette.primary, opacity: pressed ? 0.5 : 1 }]}>
                  {allOn ? t.common.disableAll : t.common.enableAll}
                </Text>
              )}
            </Pressable>
          </View>

          {options.map((option, index) => {
            const on = !draft.includes(option.value);
            // The whole row flips the switch; the switch itself only shows it, so a tap anywhere lands.
            return (
              <Pressable
                key={option.value}
                onPress={() => setDraft(toggled(draft, option.value, on))}
                accessibilityRole="switch"
                accessibilityLabel={option.label}
                accessibilityState={{ checked: on }}
                style={[styles.row, index > 0 && [styles.divided, { borderTopColor: palette.border }]]}
              >
                <Text style={[styles.label, { color: palette.text }]} numberOfLines={1}>
                  {option.label}
                </Text>
                <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                  <Switch
                    value={on}
                    trackColor={{ false: colors.border, true: colors.primary }}
                    thumbColor="#FFFFFF"
                    ios_backgroundColor={colors.border}
                  />
                </View>
              </Pressable>
            );
          })}

          <Button
            title={t.common.apply}
            onPress={() => {
              onApply(draft);
              close();
            }}
            fullWidth
            size="lg"
            style={styles.apply}
            testID="filter-apply"
          />
        </>
      )}
    </SwipeSheet>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  title: { fontSize: 26, fontWeight: '700', letterSpacing: -0.4 },
  all: { fontSize: 17 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 16, minHeight: 60 },
  divided: { borderTopWidth: StyleSheet.hairlineWidth },
  label: { flex: 1, fontSize: 17 },
  // Rounder than the standard button, like Shiftbase's.
  apply: { marginTop: 28, borderRadius: 16, borderCurve: 'continuous' },
});
