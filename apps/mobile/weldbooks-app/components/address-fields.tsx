/**
 * US address fields: street lines, city, a state picker (USPS codes) and ZIP.
 *
 * Used by the company setup, the invoice (bill-to / ship-to), the bill
 * (delivered-to) and the contact forms. The parent keeps the draft and the
 * validation result; this only draws the fields and the messages.
 */

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { Input } from '@weldsuite/mobile-ui/components/Input';
import { Select } from '@weldsuite/mobile-ui/components/Select';

import { useI18n } from '@/lib/i18n';
import {
  US_STATE_OPTIONS,
  formatZipInput,
  toUsStateCode,
  type AddressDraft,
  type usAddressProblems,
} from '@/lib/us';

export type AddressErrors = ReturnType<typeof usAddressProblems>;

export function AddressFields({
  value,
  onChange,
  errors,
}: Readonly<{
  value: AddressDraft;
  onChange: (next: AddressDraft) => void;
  errors?: AddressErrors;
}>) {
  const { colors } = useTheme();
  const { t } = useI18n();

  let stateError: string | undefined;
  if (errors?.state === 'required') stateError = t.address.stateRequired;
  else if (errors?.state === 'invalid') stateError = t.address.stateInvalid;

  let zipError: string | undefined;
  if (errors?.postalCode === 'required') zipError = t.address.zipRequired;
  else if (errors?.postalCode === 'invalid') zipError = t.address.zipInvalid;

  const set = (patch: Partial<AddressDraft>) => onChange({ ...value, ...patch });

  return (
    <View style={styles.group}>
      <Input
        label={t.address.line1}
        value={value.line1}
        onChangeText={(line1) => set({ line1 })}
        placeholder={t.address.line1Placeholder}
        autoCapitalize="words"
        autoComplete="address-line1"
      />
      <Input
        label={t.address.line2}
        value={value.line2}
        onChangeText={(line2) => set({ line2 })}
        placeholder={t.address.line2Placeholder}
        autoCapitalize="words"
        autoComplete="address-line2"
      />
      <Input
        label={t.address.city}
        value={value.city}
        onChangeText={(city) => set({ city })}
        autoCapitalize="words"
      />
      <View style={styles.row}>
        <View style={styles.state}>
          <Select
            label={t.address.state}
            value={toUsStateCode(value.state) || null}
            onValueChange={(state) => set({ state })}
            options={[...US_STATE_OPTIONS]}
            placeholder={t.address.selectState}
          />
          {stateError ? (
            <Text style={[styles.error, { color: colors.destructive }]}>{stateError}</Text>
          ) : null}
        </View>
        <Input
          label={t.address.zip}
          value={value.postalCode}
          onChangeText={(postalCode) => set({ postalCode: formatZipInput(postalCode) })}
          placeholder={t.address.zipPlaceholder}
          keyboardType="numbers-and-punctuation"
          error={zipError}
          containerStyle={styles.zip}
          autoComplete="postal-code"
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  group: { gap: 12 },
  row: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  state: { flex: 1.6 },
  zip: { flex: 1 },
  error: { fontSize: 12, marginTop: 4 },
});
