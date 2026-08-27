import { View, Text, StyleSheet, ScrollView, Pressable } from 'react-native';
import { LogOut, Moon, Sun, Globe, MessagesSquare } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';
import { useWorkspace } from '@weldsuite/mobile-ui/contexts/WorkspaceContext';

import { ACCENTS } from '@/lib/brand';
import { Screen, ScreenHeader, SectionLabel } from '@/components/screen';
import { IconTile } from '@/components/detail';
import { useI18n, type AppLanguage } from '@/lib/i18n';

export default function SettingsScreen() {
  const { theme, colors, toggleTheme } = useTheme();
  const { user, signOut } = useClerkAuth();
  const { currentWorkspace } = useWorkspace();
  const { t, language, setLanguage } = useI18n();

  const toggleLanguage = () => {
    const next: AppLanguage = language === 'en' ? 'nl' : 'en';
    setLanguage(next);
  };

  return (
    <Screen header={<ScreenHeader title={t.settings.title} />}>
      <ScrollView contentContainerStyle={styles.content}>
        <SectionLabel>{t.settings.account}</SectionLabel>
        <View style={[styles.card, { backgroundColor: colors.cardBackground, borderColor: colors.border }]}>
          <View style={[styles.row, { borderBottomColor: colors.border }]}>
            <Text style={[styles.label, { color: colors.text }]}>
              {user?.fullName || user?.email || 'User'}
            </Text>
            <Text style={[styles.value, { color: colors.mutedForeground }]} numberOfLines={1}>
              {user?.email}
            </Text>
          </View>
          {currentWorkspace ? (
            <View style={styles.row}>
              <Text style={[styles.label, { color: colors.text }]}>{t.settings.workspace}</Text>
              <Text style={[styles.value, { color: colors.mutedForeground }]}>
                {currentWorkspace.name}
              </Text>
            </View>
          ) : null}
        </View>

        <SectionLabel>{t.settings.appearance}</SectionLabel>
        <View style={[styles.card, { backgroundColor: colors.cardBackground, borderColor: colors.border }]}>
          <Pressable style={[styles.row, { borderBottomColor: colors.border }]} onPress={toggleTheme}>
            <View style={styles.rowLeft}>
              {theme === 'dark' ? (
                <Moon size={20} color={colors.text} />
              ) : (
                <Sun size={20} color={colors.text} />
              )}
              <Text style={[styles.label, { color: colors.text }]}>{t.settings.darkMode}</Text>
            </View>
            <Text style={[styles.value, { color: colors.mutedForeground }]}>
              {theme === 'dark' ? t.settings.on : t.settings.off}
            </Text>
          </Pressable>
          <Pressable style={styles.row} onPress={toggleLanguage}>
            <View style={styles.rowLeft}>
              <Globe size={20} color={colors.text} />
              <Text style={[styles.label, { color: colors.text }]}>{t.settings.language}</Text>
            </View>
            <Text style={[styles.value, { color: colors.mutedForeground }]}>
              {t.languageNames[language]}
            </Text>
          </Pressable>
        </View>

        <SectionLabel>{t.settings.channels}</SectionLabel>
        <View style={[styles.card, { backgroundColor: colors.cardBackground, borderColor: colors.border }]}>
          <View style={styles.channelHint}>
            <IconTile icon={MessagesSquare} color={ACCENTS.chat} />
            <Text style={[styles.hintText, { color: colors.mutedForeground }]}>
              {t.settings.channelsHint}
            </Text>
          </View>
        </View>

        <Pressable style={styles.signOut} onPress={() => void signOut()}>
          <LogOut size={20} color="#EF4444" />
          <Text style={styles.signOutText}>{t.settings.signOut}</Text>
        </Pressable>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: 32 },
  card: {
    marginHorizontal: 16,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 12,
  },
  rowLeft: { flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1 },
  label: { fontSize: 16, fontWeight: '500' },
  value: { fontSize: 14, flexShrink: 1, textAlign: 'right' },
  channelHint: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    padding: 16,
  },
  hintText: { flex: 1, fontSize: 14, lineHeight: 20 },
  signOut: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    marginTop: 28,
    paddingVertical: 16,
  },
  signOutText: { fontSize: 16, fontWeight: '600', color: '#EF4444' },
});
