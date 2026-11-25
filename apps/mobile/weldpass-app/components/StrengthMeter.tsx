import { StyleSheet, Text, View } from 'react-native';
import { passwordEntropyBits, passwordStrength } from '@weldsuite/app-api-client/schemas/weldpass-passwords';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';

import { STRENGTH_COLORS } from '@/lib/brand';
import { useI18n } from '@/lib/i18n';

const FILLED = { weak: 1, fair: 2, strong: 3 } as const;

/** Three bars and a word, from the same estimate the server's health check uses. */
export function StrengthMeter({ password }: Readonly<{ password: string }>) {
  const { t, format } = useI18n();
  const { colors } = useTheme();
  if (!password) return null;
  const strength = passwordStrength(password);
  const bits = Math.round(passwordEntropyBits(password));
  const color = STRENGTH_COLORS[strength];

  return (
    <View style={styles.wrap} accessibilityLabel={`${t.strength.label}: ${t.strength[strength]}`}>
      <View style={styles.bars}>
        {[1, 2, 3].map((index) => (
          <View
            key={index}
            style={[styles.bar, { backgroundColor: index <= FILLED[strength] ? color : colors.border }]}
          />
        ))}
      </View>
      <Text style={[styles.label, { color }]}>{t.strength[strength]}</Text>
      <Text style={[styles.bits, { color: colors.mutedForeground }]}>{format(t.strength.bits, { bits })}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  bars: { flexDirection: 'row', gap: 4, flex: 1 },
  bar: { flex: 1, height: 6, borderRadius: 3 },
  label: { fontSize: 14, fontWeight: '600' },
  bits: { fontSize: 13 },
});
