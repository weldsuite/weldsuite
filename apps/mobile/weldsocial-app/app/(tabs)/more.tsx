import React from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { BarChart3, AtSign, Megaphone, Settings } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useWorkspace } from '@weldsuite/mobile-ui/contexts/WorkspaceContext';
import { Card } from '@weldsuite/mobile-ui/components/Card';
import { ListItem } from '@weldsuite/mobile-ui/components/ListItem';
import { useI18n } from '@/lib/i18n';

export default function MoreScreen() {
  const { colors } = useTheme();
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { currentWorkspace } = useWorkspace();

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: colors.background }]}
      contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
    >
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Text style={[styles.greeting, { color: colors.muted }]}>
          {currentWorkspace?.name || t.common.workspace}
        </Text>
        <Text style={[styles.title, { color: colors.text }]}>{t.more.title}</Text>
      </View>

      <View style={styles.section}>
        <Card>
          <ListItem
            title={t.more.analytics}
            subtitle={t.more.analyticsHint}
            leftElement={<BarChart3 size={20} color={colors.text} />}
            showChevron
            onPress={() => router.push('/analytics')}
            divider
          />
          <ListItem
            title={t.more.accounts}
            subtitle={t.more.accountsHint}
            leftElement={<AtSign size={20} color={colors.text} />}
            showChevron
            onPress={() => router.push('/accounts')}
            divider
          />
          <ListItem
            title={t.more.campaigns}
            subtitle={t.more.campaignsHint}
            leftElement={<Megaphone size={20} color={colors.text} />}
            showChevron
            onPress={() => router.push('/campaigns')}
          />
        </Card>
      </View>

      <View style={styles.section}>
        <Card>
          <ListItem
            title={t.more.settings}
            subtitle={t.more.settingsHint}
            leftElement={<Settings size={20} color={colors.text} />}
            showChevron
            onPress={() => router.push('/settings')}
          />
        </Card>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { paddingHorizontal: 16, paddingBottom: 16 },
  greeting: { fontSize: 15, fontWeight: '500', marginBottom: 4 },
  title: { fontSize: 34, fontWeight: '700' },
  section: { paddingHorizontal: 16, marginBottom: 16 },
});
