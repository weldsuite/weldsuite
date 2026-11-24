/**
 * The password generator: the same `generatePassword` the platform and the
 * extension use, on the device's `crypto.getRandomValues` (lib/polyfills.ts).
 * Nothing here is stored or sent; a copy is cleared after 30 s.
 */

import { useCallback, useEffect, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Minus, Plus, RefreshCw } from 'lucide-react-native';
import { generatePassword } from '@weldsuite/app-api-client/schemas/weldpass-passwords';
import { Button } from '@weldsuite/mobile-ui/components/Button';
import { Switch } from '@weldsuite/mobile-ui/components/Switch';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';

import { Group } from '@/components/Group';
import { Screen } from '@/components/Screen';
import { StrengthMeter } from '@/components/StrengthMeter';
import { copySecret } from '@/lib/clipboard';
import { useI18n } from '@/lib/i18n';

const MIN_LENGTH = 8;
const MAX_LENGTH = 64;

interface GeneratorOptions {
  length: number;
  uppercase: boolean;
  digits: boolean;
  symbols: boolean;
}

export default function GeneratorScreen() {
  const { t, format } = useI18n();
  const { colors } = useTheme();
  const toast = useToast();
  const [options, setOptions] = useState<GeneratorOptions>({ length: 20, uppercase: true, digits: true, symbols: true });
  const [password, setPassword] = useState('');

  const regenerate = useCallback(() => setPassword(generatePassword(options)), [options]);
  useEffect(regenerate, [regenerate]);

  const change = (patch: Partial<GeneratorOptions>) => setOptions((current) => ({ ...current, ...patch }));
  const copy = async () => {
    await copySecret(password);
    toast.success(format(t.item.copiedSecret, { field: t.item.password }));
  };

  return (
    <Screen title={t.generator.title}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={[styles.output, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.password, { color: colors.text }]} selectable={false} testID="generated-password">
            {password}
          </Text>
          <StrengthMeter password={password} />
          <View style={styles.buttons}>
            <Button title={t.generator.copy} onPress={() => void copy()} style={styles.button} testID="copy-generated" />
            <Button
              title={t.generator.regenerate}
              variant="outline"
              leftIcon={<RefreshCw size={16} color={colors.text} />}
              onPress={regenerate}
              style={styles.button}
            />
          </View>
        </View>

        <Group footer={t.generator.hint}>
          <View style={styles.lengthRow}>
            <Text style={[styles.lengthLabel, { color: colors.text }]}>{t.generator.length}</Text>
            <Stepper
              value={options.length}
              onChange={(length) => change({ length })}
              lessLabel={t.generator.shorter}
              moreLabel={t.generator.longer}
            />
          </View>
          <View style={styles.switchRow}>
            <Switch label={t.generator.uppercase} value={options.uppercase} onValueChange={(uppercase) => change({ uppercase })} />
          </View>
          <View style={styles.switchRow}>
            <Switch label={t.generator.digits} value={options.digits} onValueChange={(digits) => change({ digits })} />
          </View>
          <View style={styles.switchRow}>
            <Switch label={t.generator.symbols} value={options.symbols} onValueChange={(symbols) => change({ symbols })} />
          </View>
        </Group>
      </ScrollView>
    </Screen>
  );
}

function Stepper({
  value,
  onChange,
  lessLabel,
  moreLabel,
}: Readonly<{ value: number; onChange: (value: number) => void; lessLabel: string; moreLabel: string }>) {
  const { colors } = useTheme();
  const step = (delta: number) => onChange(Math.min(MAX_LENGTH, Math.max(MIN_LENGTH, value + delta)));
  return (
    <View style={styles.stepper} accessibilityRole="adjustable" accessibilityValue={{ min: MIN_LENGTH, max: MAX_LENGTH, now: value }}>
      <Pressable
        onPress={() => step(-1)}
        onLongPress={() => step(-8)}
        disabled={value <= MIN_LENGTH}
        accessibilityRole="button"
        accessibilityLabel={lessLabel}
        style={[styles.stepButton, { backgroundColor: colors.secondary, opacity: value <= MIN_LENGTH ? 0.4 : 1 }]}
      >
        <Minus size={18} color={colors.text} />
      </Pressable>
      <Text style={[styles.stepValue, { color: colors.text }]}>{value}</Text>
      <Pressable
        onPress={() => step(1)}
        onLongPress={() => step(8)}
        disabled={value >= MAX_LENGTH}
        accessibilityRole="button"
        accessibilityLabel={moreLabel}
        style={[styles.stepButton, { backgroundColor: colors.secondary, opacity: value >= MAX_LENGTH ? 0.4 : 1 }]}
      >
        <Plus size={18} color={colors.text} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: 120, gap: 8 },
  output: { marginHorizontal: 16, marginBottom: 16, padding: 16, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, gap: 14 },
  password: {
    fontSize: 22,
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
    lineHeight: 30,
  },
  buttons: { flexDirection: 'row', gap: 10 },
  button: { flex: 1 },
  lengthRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 10 },
  lengthLabel: { flex: 1, fontSize: 16 },
  switchRow: { paddingHorizontal: 14, paddingVertical: 4 },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  stepButton: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  stepValue: { fontSize: 17, fontWeight: '600', minWidth: 28, textAlign: 'center', fontVariant: ['tabular-nums'] },
});
