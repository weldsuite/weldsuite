import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView, Switch } from 'react-native';
import MaterialSpinner from '@/components/MaterialSpinner';
import { useRouter } from 'expo-router';
import * as Updates from 'expo-updates';
import * as Application from 'expo-application';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';
import { useWorkspace } from '@weldsuite/mobile-ui/contexts/WorkspaceContext';
import { useNotifications } from '@/contexts/NotificationContext';
import { ChevronLeft, LogOut, Moon, Sun, Building2, Check } from 'lucide-react-native';

export default function SettingsScreen() {
  const { theme, colors, toggleTheme } = useTheme();
  const { user, signOut } = useClerkAuth();
  const { currentWorkspace, workspaces, switchWorkspace, hasMultipleWorkspaces } = useWorkspace();
  const { unregisterDevice } = useNotifications();
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const isDark = theme === 'dark';
  const bg = isDark ? colors.background : '#FFFFFF';
  const cardBg = isDark ? '#1C1C1E' : '#F6F7F8';
  const borderColor = isDark ? '#38383A' : '#EEEFF1';
  const sectionBorderColor = isDark ? '#38383A' : '#EEEFF1';
  const iconCircleBg = isDark ? '#2C2C2E' : '#F1F3F4';
  const mutedText = isDark ? '#8E8E93' : '#9CA3AF';
  const subtleIcon = isDark ? '#8E8E93' : '#5F6368';

  // Build/OTA readout. `Application` gives the native binary version; the
  // `Updates.*` constants describe the JS bundle actually running — which is
  // how you tell whether an OTA update has landed on this device. In a dev
  // build `Updates.isEnabled` is false and the ids are null.
  const appVersion = Application.nativeApplicationVersion ?? '—';
  const buildVersion = Application.nativeBuildVersion ?? '—';
  const updateStatus = !Updates.isEnabled
    ? 'Dev build'
    : Updates.isEmbeddedLaunch
      ? 'Embedded (no OTA yet)'
      : Updates.updateId
        ? Updates.updateId.slice(0, 8)
        : '—';
  const publishedAt = Updates.createdAt ? Updates.createdAt.toLocaleString() : '—';
  const aboutRows: { label: string; value: string }[] = [
    { label: 'Version', value: `${appVersion} (${buildVersion})` },
    { label: 'Runtime', value: Updates.runtimeVersion ?? '—' },
    { label: 'Channel', value: Updates.channel ?? '—' },
    { label: 'Update', value: updateStatus },
    { label: 'Published', value: publishedAt },
  ];

  // Deactivate this device's push token before tearing down the session, so the
  // backend stops delivering this user's mail notifications to the device. The
  // unregister call is best-effort and never throws, so sign-out still proceeds.
  const handleSignOut = async () => {
    await unregisterDevice();
    await signOut();
  };

  const handleSwitchWorkspace = async (clerkOrgId: string) => {
    if (switchingId) return;
    setSwitchingId(clerkOrgId);
    try {
      await switchWorkspace(clerkOrgId);
    } catch (err) {
      console.error('Failed to switch workspace:', err);
    } finally {
      setSwitchingId(null);
    }
  };

  return (
    <ScrollView style={[styles.container, { backgroundColor: bg }]}>
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10} style={styles.backButton}>
          <ChevronLeft size={26} color={colors.text} strokeWidth={2} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Settings</Text>
      </View>

      {/* Account Section */}
      <View style={[styles.section, { backgroundColor: cardBg, borderColor: sectionBorderColor }]}>
        <Text style={[styles.sectionTitle, { color: mutedText }]}>Account</Text>
        <View style={[styles.row, { borderBottomColor: borderColor }]}>
          <Text style={[styles.label, { color: colors.text }]}>{user?.fullName || user?.email || 'User'}</Text>
          <Text style={[styles.value, { color: mutedText }]}>{user?.email}</Text>
        </View>
        {currentWorkspace && (
          <View style={[styles.row, { borderBottomWidth: 0 }]}>
            <Text style={[styles.label, { color: colors.text }]}>Workspace</Text>
            <Text style={[styles.value, { color: mutedText }]}>{currentWorkspace.name}</Text>
          </View>
        )}
      </View>

      {/* Workspace Section */}
      {hasMultipleWorkspaces && (
        <View style={[styles.section, { backgroundColor: cardBg, borderColor: sectionBorderColor }]}>
          <Text style={[styles.sectionTitle, { color: mutedText }]}>Workspace</Text>
          {workspaces.map((ws, i) => {
            const isActive = currentWorkspace?.clerkOrgId === ws.clerkOrgId;
            const isLast = i === workspaces.length - 1;
            const isSwitching = switchingId === ws.clerkOrgId;
            return (
              <TouchableOpacity
                key={ws.id}
                style={[styles.row, !isLast ? { borderBottomColor: borderColor } : { borderBottomWidth: 0 }]}
                onPress={() => !isActive && handleSwitchWorkspace(ws.clerkOrgId)}
                activeOpacity={isActive ? 1 : 0.6}
              >
                <View style={styles.rowLeft}>
                  <View style={[styles.iconCircle, { backgroundColor: iconCircleBg }, isActive && { backgroundColor: isDark ? '#1A2744' : '#E8F0FE' }]}>
                    <Building2 size={16} color={isActive ? '#4D94F8' : subtleIcon} strokeWidth={2} />
                  </View>
                  <Text style={[styles.label, { color: colors.text }, isActive && { fontWeight: '600' }]}>{ws.name}</Text>
                </View>
                {isSwitching ? (
                  <MaterialSpinner size={18} strokeWidth={2.4} color="#4D94F8" spinning />
                ) : isActive ? (
                  <View style={styles.checkCircle}>
                    <Check size={14} color="#FFFFFF" strokeWidth={3} />
                  </View>
                ) : (
                  <View style={[styles.emptyCircle, isDark && { borderColor: '#48484A' }]} />
                )}
              </TouchableOpacity>
            );
          })}
        </View>
      )}

      {/* Appearance Section */}
      <View style={[styles.section, { backgroundColor: cardBg, borderColor: sectionBorderColor }]}>
        <Text style={[styles.sectionTitle, { color: mutedText }]}>Appearance</Text>
        <TouchableOpacity style={[styles.row, { borderBottomWidth: 0 }]} onPress={toggleTheme} activeOpacity={0.6}>
          <View style={styles.rowLeft}>
            <View style={[styles.iconCircle, { backgroundColor: iconCircleBg }]}>
              {theme === 'dark' ? <Moon size={18} color={subtleIcon} /> : <Sun size={18} color={subtleIcon} />}
            </View>
            <Text style={[styles.label, { color: colors.text }]}>Dark Mode</Text>
          </View>
          <Switch
            value={theme === 'dark'}
            onValueChange={toggleTheme}
            trackColor={{ false: isDark ? '#48484A' : '#DADCE0', true: '#4D94F8' }}
            thumbColor="#FFFFFF"
          />
        </TouchableOpacity>
      </View>

      {/* About Section — app version + which JS bundle (OTA) is running */}
      <View style={[styles.section, { backgroundColor: cardBg, borderColor: sectionBorderColor }]}>
        <Text style={[styles.sectionTitle, { color: mutedText }]}>About</Text>
        {aboutRows.map((r, i) => (
          <View
            key={r.label}
            style={[styles.row, i === aboutRows.length - 1 ? { borderBottomWidth: 0 } : { borderBottomColor: borderColor }]}
          >
            <Text style={[styles.label, { color: colors.text }]}>{r.label}</Text>
            <Text style={[styles.value, { color: mutedText }]} numberOfLines={1}>{r.value}</Text>
          </View>
        ))}
      </View>

      {/* Sign Out */}
      <TouchableOpacity style={[styles.signOutButton, { borderColor: sectionBorderColor }]} onPress={handleSignOut} activeOpacity={0.6}>
        <LogOut size={18} color="#EF4444" />
        <Text style={styles.signOutText}>Sign Out</Text>
      </TouchableOpacity>

      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 24,
    gap: 10,
  },
  backButton: { padding: 6 },
  headerTitle: { fontSize: 22, fontWeight: '600' },
  section: { marginHorizontal: 16, marginBottom: 16, borderRadius: 16, overflow: 'hidden', borderWidth: 1 },
  sectionTitle: { fontSize: 11, fontWeight: '600', paddingHorizontal: 18, paddingTop: 16, paddingBottom: 8, textTransform: 'uppercase', letterSpacing: 0.8 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 18, paddingVertical: 15, borderBottomWidth: StyleSheet.hairlineWidth },
  rowLeft: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  iconCircle: { width: 34, height: 34, borderRadius: 10, justifyContent: 'center', alignItems: 'center' },
  label: { fontSize: 16, fontWeight: '400' },
  value: { fontSize: 14, fontWeight: '400' },
  checkCircle: { width: 24, height: 24, borderRadius: 7, backgroundColor: '#4D94F8', justifyContent: 'center', alignItems: 'center' },
  emptyCircle: { width: 24, height: 24, borderRadius: 7, borderWidth: 1.5, borderColor: '#DADCE0' },
  signOutButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, marginHorizontal: 16, marginTop: 8, paddingVertical: 14, borderWidth: 1, borderRadius: 12 },
  signOutText: { fontSize: 15, fontWeight: '600', color: '#EF4444' },
});
