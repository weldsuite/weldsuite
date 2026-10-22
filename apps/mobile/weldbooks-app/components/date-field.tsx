/**
 * A date field that opens the phone's own date picker instead of asking for
 * `YYYY-MM-DD` to be typed.
 *
 * The value is the ISO calendar day (`YYYY-MM-DD`) every WeldBooks form and the API
 * use; the field shows it in the locale of the company (5 Aug 2026, 5 aug. 2026,
 * 08/05/2026 for US English). Android opens its date dialog; iOS shows a spinner in a
 * sheet with a Done button.
 */

import React, { useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { Calendar } from 'lucide-react-native';

import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { Button } from '@weldsuite/mobile-ui/components/Button';
import { Sheet } from '@weldsuite/mobile-ui/components/Sheet';

import { BRAND } from '@/lib/brand';
import { isoToPickerDate, toDateInput } from '@/lib/date';
import { useI18n, useLocaleFormatters } from '@/lib/i18n';

export function DateField({
  label,
  value,
  onChange,
  error,
  testID,
}: Readonly<{
  label: string;
  /** `YYYY-MM-DD`, or '' for no date yet. */
  value: string;
  onChange: (iso: string) => void;
  error?: string;
  testID?: string;
}>) {
  const { colors, theme } = useTheme();
  const { t } = useI18n();
  const { formatDate } = useLocaleFormatters();
  const [open, setOpen] = useState(false);

  const picked = isoToPickerDate(value);
  const handleValueChange = (_event: unknown, selected: Date) => {
    onChange(toDateInput(selected));
    if (Platform.OS === 'android') setOpen(false);
  };

  let borderColor = colors.border;
  if (error) borderColor = colors.destructive;
  else if (open) borderColor = colors.ring;

  return (
    <View style={styles.container}>
      <Text style={[styles.label, { color: colors.text }]}>{label}</Text>
      <Pressable
        testID={testID}
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityValue={{ text: value ? formatDate(value) : t.common.chooseDate }}
        style={({ pressed }) => [
          styles.field,
          { backgroundColor: colors.inputBackground, borderColor, opacity: pressed ? 0.85 : 1 },
        ]}
      >
        <Text style={[styles.value, { color: value ? colors.text : colors.placeholder }]} numberOfLines={1}>
          {value ? formatDate(value) : t.common.chooseDate}
        </Text>
        <Calendar size={18} color={colors.mutedForeground} />
      </Pressable>
      {error ? <Text style={[styles.error, { color: colors.destructive }]}>{error}</Text> : null}

      {open && Platform.OS === 'android' ? (
        <DateTimePicker
          value={picked}
          mode="date"
          display="default"
          positiveButton={{ textColor: BRAND }}
          negativeButton={{ textColor: BRAND }}
          onValueChange={handleValueChange}
          onDismiss={() => setOpen(false)}
        />
      ) : null}

      {Platform.OS === 'ios' ? (
        <Sheet visible={open} onClose={() => setOpen(false)} title={label} heightRatio={0.5}>
          <DateTimePicker
            value={picked}
            mode="date"
            display="spinner"
            themeVariant={theme === 'dark' ? 'dark' : 'light'}
            onValueChange={handleValueChange}
          />
          <Button title={t.common.confirm} onPress={() => setOpen(false)} fullWidth style={styles.done} />
        </Sheet>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 4 },
  label: { fontSize: 14, fontWeight: '500' },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 44,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth * 2,
  },
  value: { flex: 1, fontSize: 15 },
  error: { fontSize: 13 },
  done: { marginTop: 8 },
});
