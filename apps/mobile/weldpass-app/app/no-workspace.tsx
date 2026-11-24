/**
 * Signed in, but in no workspace: WeldPass vaults live in a workspace. Offers
 * the server's own web app to create one (never a hard-coded host: this may
 * be a self-hosted server) and a re-check.
 */

import { useCallback, useEffect, useState } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Building2 } from 'lucide-react-native';
import { useOrganizationList } from '@weldsuite/mobile-platform/auth';
import { platformUrl } from '@weldsuite/mobile-platform/api';
import { Button } from '@weldsuite/mobile-ui/components/Button';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';

import { useOffline } from '@/contexts/OfflineContext';
import { BRAND } from '@/lib/brand';
import { useI18n } from '@/lib/i18n';
import { hideAppSplash } from '@/utils/splash';

export default function NoWorkspaceScreen() {
  const { t } = useI18n();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { signOut } = useOffline();
  const { userMemberships } = useOrganizationList({ userMemberships: { infinite: true } });
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    hideAppSplash();
  }, []);

  const check = useCallback(async () => {
    setChecking(true);
    try {
      await userMemberships?.revalidate?.();
      if ((userMemberships?.data?.length ?? 0) > 0) router.replace('/(tabs)');
    } catch {
      // The person can try again.
    } finally {
      setChecking(false);
    }
  }, [router, userMemberships]);

  return (
    <View style={[styles.page, { paddingTop: insets.top + 48, backgroundColor: colors.background }]}>
      <Building2 size={40} color={BRAND} />
      <Text style={[styles.title, { color: colors.text }]}>{t.noWorkspace.title}</Text>
      <Text style={[styles.text, { color: colors.mutedForeground }]}>{t.noWorkspace.description}</Text>
      <View style={styles.actions}>
        <Button title={t.noWorkspace.create} onPress={() => void Linking.openURL(platformUrl())} fullWidth />
        <Button title={t.noWorkspace.check} variant="outline" loading={checking} onPress={() => void check()} fullWidth />
        <Button title={t.noWorkspace.signOut} variant="ghost" onPress={() => void signOut()} fullWidth />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, alignItems: 'center', paddingHorizontal: 28, gap: 12 },
  title: { fontSize: 22, fontWeight: '700', textAlign: 'center', marginTop: 8 },
  text: { fontSize: 15, textAlign: 'center' },
  actions: { alignSelf: 'stretch', gap: 10, marginTop: 24 },
});
