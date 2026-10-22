import React, { useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Check, ChevronRight, ListChecks, LogOut, Moon, Send, Sun, type LucideIcon } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';
import { useWorkspace } from '@weldsuite/mobile-ui/contexts/WorkspaceContext';
import { SegmentedControl } from '@weldsuite/mobile-ui/components/SegmentedControl';
import { APP_LANGUAGES, isAppLanguage, useI18n } from '@/lib/i18n';

interface LinkRowProps {
  icon: LucideIcon;
  label: string;
  hint: string;
  onPress: () => void;
  last?: boolean;
}

function LinkRow({ icon: Icon, label, hint, onPress, last }: Readonly<LinkRowProps>) {
  const { colors } = useTheme();
  return (
    <TouchableOpacity
      style={[styles.row, last && styles.lastRow, { borderBottomColor: colors.divider }]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <View style={styles.rowLeft}>
        <Icon size={20} color={colors.text} />
        <View style={styles.rowText}>
          <Text style={[styles.label, { color: colors.text }]}>{label}</Text>
          <Text style={[styles.hint, { color: colors.muted }]} numberOfLines={1}>
            {hint}
          </Text>
        </View>
      </View>
      <ChevronRight size={18} color={colors.muted} />
    </TouchableOpacity>
  );
}

export default function MoreScreen() {
  const { theme, colors, toggleTheme } = useTheme();
  const { user, signOut } = useClerkAuth();
  const { currentWorkspace, workspaces, switchWorkspace } = useWorkspace();
  const { t, language, setLanguage } = useI18n();
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const [switchingId, setSwitchingId] = useState<string | null>(null);

  const handleSwitch = async (clerkOrgId: string) => {
    setSwitchingId(clerkOrgId);
    try {
      await switchWorkspace(clerkOrgId);
      router.navigate('/');
    } catch {
      toast.error(t.more.switchFailed);
    } finally {
      setSwitchingId(null);
    }
  };

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: colors.background }]}
      contentContainerStyle={{ paddingBottom: 32 }}
    >
      <View style={[styles.header, { paddingTop: insets.top + 16 }]}>
        <Text style={[styles.headerTitle, { color: colors.text }]} accessibilityRole="header">
          {t.more.title}
        </Text>
      </View>

      <View style={[styles.section, { backgroundColor: colors.card }]}>
        <Text style={[styles.sectionTitle, { color: colors.muted }]}>{t.more.crm}</Text>
        <LinkRow icon={ListChecks} label={t.more.lists} hint={t.more.listsHint} onPress={() => router.push('/lists')} />
        <LinkRow
          icon={Send}
          label={t.more.sequences}
          hint={t.more.sequencesHint}
          onPress={() => router.push('/sequences')}
          last
        />
      </View>

      {workspaces.length > 1 && (
        <View style={[styles.section, { backgroundColor: colors.card }]}>
          <Text style={[styles.sectionTitle, { color: colors.muted }]}>{t.more.workspaces}</Text>
          {workspaces.map((ws, index) => {
            const isActive = currentWorkspace?.clerkOrgId === ws.clerkOrgId;
            const isSwitching = switchingId === ws.clerkOrgId;
            return (
              <TouchableOpacity
                key={ws.id}
                style={[
                  styles.row,
                  index === workspaces.length - 1 && styles.lastRow,
                  { borderBottomColor: colors.divider },
                ]}
                onPress={() => void handleSwitch(ws.clerkOrgId)}
                disabled={isActive || switchingId !== null}
                accessibilityRole="button"
                accessibilityState={{ selected: isActive, busy: isSwitching }}
                accessibilityLabel={ws.name}
              >
                <Text style={[styles.label, { color: colors.text }]} numberOfLines={1}>
                  {ws.name}
                </Text>
                {isSwitching && <ActivityIndicator size="small" color={colors.text} />}
                {isActive && !isSwitching && <Check size={18} color={colors.text} />}
              </TouchableOpacity>
            );
          })}
        </View>
      )}

      <View style={[styles.section, { backgroundColor: colors.card }]}>
        <Text style={[styles.sectionTitle, { color: colors.muted }]}>{t.settings.account}</Text>
        <View style={[styles.row, { borderBottomColor: colors.divider }]}>
          <Text style={[styles.label, { color: colors.text }]}>{t.settings.name}</Text>
          <Text style={[styles.value, { color: colors.muted }]}>{user?.fullName || t.common.dash}</Text>
        </View>
        <View style={[styles.row, !currentWorkspace && styles.lastRow, { borderBottomColor: colors.divider }]}>
          <Text style={[styles.label, { color: colors.text }]}>{t.settings.email}</Text>
          <Text style={[styles.value, { color: colors.muted }]} numberOfLines={1}>
            {user?.email || t.common.dash}
          </Text>
        </View>
        {currentWorkspace && (
          <View style={[styles.row, styles.lastRow]}>
            <Text style={[styles.label, { color: colors.text }]}>{t.settings.workspace}</Text>
            <Text style={[styles.value, { color: colors.muted }]} numberOfLines={1}>
              {currentWorkspace.name}
            </Text>
          </View>
        )}
      </View>

      <View style={[styles.section, { backgroundColor: colors.card }]}>
        <Text style={[styles.sectionTitle, { color: colors.muted }]}>{t.settings.appearance}</Text>
        <TouchableOpacity
          style={[styles.row, { borderBottomColor: colors.divider }]}
          onPress={toggleTheme}
          accessibilityRole="switch"
          accessibilityState={{ checked: theme === 'dark' }}
          accessibilityLabel={t.settings.darkMode}
        >
          <View style={styles.rowLeft}>
            {theme === 'dark' ? <Moon size={20} color={colors.text} /> : <Sun size={20} color={colors.text} />}
            <Text style={[styles.label, { color: colors.text }]}>{t.settings.darkMode}</Text>
          </View>
          <Text style={[styles.value, { color: colors.muted }]}>{theme === 'dark' ? t.settings.on : t.settings.off}</Text>
        </TouchableOpacity>
        <View style={styles.languageRow}>
          <Text style={[styles.label, { color: colors.text }]}>{t.settings.language}</Text>
          <SegmentedControl
            options={APP_LANGUAGES.map((code) => ({ value: code, label: t.languageNames[code] }))}
            value={language}
            onValueChange={(value) => {
              if (isAppLanguage(value)) setLanguage(value);
            }}
            style={styles.languagePicker}
          />
        </View>
      </View>

      <TouchableOpacity style={styles.signOutButton} onPress={signOut} accessibilityRole="button">
        <LogOut size={20} color="#EF4444" />
        <Text style={styles.signOutText}>{t.settings.signOut}</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { paddingHorizontal: 16, paddingBottom: 16 },
  headerTitle: { fontSize: 34, fontWeight: '700' },
  section: { marginHorizontal: 16, marginBottom: 24, borderRadius: 12, overflow: 'hidden' },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '500',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 8,
    textTransform: 'uppercase',
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 0.5,
  },
  lastRow: { borderBottomWidth: 0 },
  rowLeft: { flexDirection: 'row', alignItems: 'center', gap: 12, flexShrink: 1 },
  rowText: { flexShrink: 1 },
  label: { fontSize: 16, flexShrink: 1 },
  hint: { fontSize: 12, marginTop: 2 },
  value: { fontSize: 15, flexShrink: 1 },
  languageRow: { paddingHorizontal: 16, paddingVertical: 14, gap: 10 },
  languagePicker: { alignSelf: 'stretch' },
  signOutButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginHorizontal: 16,
    paddingVertical: 16,
    justifyContent: 'center',
  },
  signOutText: { fontSize: 16, fontWeight: '500', color: '#EF4444' },
});
