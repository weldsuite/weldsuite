/**
 * Due date input: quick presets plus a YYYY-MM-DD text field, so any day can
 * be picked without a native date picker. The value is the text in the field;
 * parse it with `parseDateInput` when submitting.
 */

import React from 'react';
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useI18n } from '@/lib/i18n';
import { dueDateFromToday, toDateInput } from '@/lib/dates';

interface DueDateFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string | null;
  /** Offer a "Clear date" link while a date is set. */
  allowClear?: boolean;
}

const PRESETS = [
  { key: 'dateToday', offsetDays: 0 },
  { key: 'dateTomorrow', offsetDays: 1 },
  { key: 'dateNextWeek', offsetDays: 7 },
] as const;

export function DueDateField({ label, value, onChange, error, allowClear = true }: Readonly<DueDateFieldProps>) {
  const { colors } = useTheme();
  const { t } = useI18n();
  return (
    <View style={styles.wrap}>
      <Text style={[styles.label, { color: colors.muted }]}>{label}</Text>
      <View style={styles.presets}>
        {PRESETS.map((preset) => {
          const presetValue = toDateInput(dueDateFromToday(preset.offsetDays));
          const active = value.trim() === presetValue;
          return (
            <TouchableOpacity
              key={preset.key}
              style={[
                styles.preset,
                {
                  backgroundColor: active ? '#DBEAFE' : colors.background,
                  borderColor: active ? '#3B82F6' : colors.divider,
                },
              ]}
              onPress={() => onChange(presetValue)}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
            >
              <Text style={[styles.presetText, { color: active ? '#3B82F6' : colors.text }]}>
                {t.tasks[preset.key]}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
      <TextInput
        accessibilityLabel={label}
        style={[
          styles.input,
          {
            color: colors.text,
            borderColor: error ? colors.destructive : colors.divider,
            backgroundColor: colors.background,
          },
        ]}
        value={value}
        onChangeText={onChange}
        placeholder={t.tasks.dueDatePlaceholder}
        placeholderTextColor={colors.muted}
        keyboardType="numbers-and-punctuation"
        maxLength={10}
      />
      {error ? <Text style={[styles.error, { color: colors.destructive }]}>{error}</Text> : null}
      {allowClear && value.trim().length > 0 ? (
        <TouchableOpacity style={styles.clear} onPress={() => onChange('')} accessibilityRole="button">
          <Text style={[styles.clearText, { color: colors.muted }]}>{t.tasks.clearDate}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: 16 },
  label: { fontSize: 13, fontWeight: '500', marginBottom: 6 },
  presets: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 10 },
  preset: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 6, borderWidth: 1 },
  presetText: { fontSize: 13, fontWeight: '500' },
  input: { fontSize: 15, borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10 },
  error: { fontSize: 12, marginTop: 4 },
  clear: { marginTop: 8, alignSelf: 'flex-start' },
  clearText: { fontSize: 13, textDecorationLine: 'underline' },
});
