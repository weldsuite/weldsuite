/**
 * The current 2FA code, minted by the server (PASS-007: the seed stays in
 * the vault), with its countdown. A new code is fetched when this one runs
 * out, while the screen is open.
 */

import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Copy } from 'lucide-react-native';
import { useQuery } from '@tanstack/react-query';
import { formatTotpCode, secondsUntil } from '@weldsuite/app-api-client/schemas/weldpass-items';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';

import { useI18n } from '@/lib/i18n';
import { appApi } from '@/services/app-api';

export function TotpCode({
  vaultId,
  itemId,
  onCopy,
}: Readonly<{ vaultId: string; itemId: string; onCopy: (code: string) => void }>) {
  const { t, plural } = useI18n();
  const { colors } = useTheme();
  const [now, setNow] = useState(() => Date.now());

  const code = useQuery({
    queryKey: ['weldpass-totp', vaultId, itemId],
    queryFn: async () => (await appApi.passwords.generateTotp(vaultId, itemId)).data,
    gcTime: 0,
    staleTime: 0,
    refetchOnWindowFocus: true,
  });

  const left = code.data ? secondsUntil(code.data.expiresAt, now) : 0;
  const { refetch } = code;

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (code.data && left === 0 && !code.isFetching) void refetch();
  }, [code.data, code.isFetching, left, refetch]);

  const copy = useCallback(() => {
    if (code.data) onCopy(code.data.code);
  }, [code.data, onCopy]);

  return (
    <Pressable
      onPress={copy}
      disabled={!code.data}
      accessibilityRole="button"
      accessibilityLabel={`${t.item.totp}, ${t.common.copy}`}
      style={styles.row}
    >
      <View style={styles.text}>
        <Text style={[styles.label, { color: colors.mutedForeground }]}>{t.item.totp}</Text>
        <Text style={[styles.code, { color: colors.text }]} selectable={false}>
          {code.data ? formatTotpCode(code.data.code) : t.common.dash}
        </Text>
        {code.data ? (
          <Text style={[styles.countdown, { color: colors.mutedForeground }]}>
            {plural(left, t.item.totpExpires)}
          </Text>
        ) : null}
      </View>
      <Copy size={20} color={colors.mutedForeground} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 12, gap: 12 },
  text: { flex: 1, gap: 2 },
  label: { fontSize: 13 },
  code: { fontSize: 26, fontWeight: '600', letterSpacing: 2, fontVariant: ['tabular-nums'] },
  countdown: { fontSize: 13 },
});
