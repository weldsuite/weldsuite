import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView, Switch } from 'react-native';
import { useRouter } from 'expo-router';
import * as Updates from 'expo-updates';
import * as Application from 'expo-application';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';
import { useWorkspace } from '@weldsuite/mobile-ui/contexts/WorkspaceContext';
import { Card } from '@weldsuite/mobile-ui/components/Card';
import { Spinner } from '@weldsuite/mobile-ui/components/Spinner';
import { LogOut, Moon, Sun, Building2, Check, Bell } from 'lucide-react-native';
import { Screen, ScreenHeader, SectionLabel } from '@/components/screen';
import { BRAND, BRAND_TINT, tint, ACCENTS } from '@/lib/brand';
import { useNotifications } from '@/contexts/NotificationContext';

export default function SettingsScreen() {
  const { theme, colors, toggleTheme } = useTheme();
  const { user, signOut } = useClerkAuth();
  const { currentWorkspace, workspaces, switchWorkspace } = useWorkspace();
  const {
    isPermissionGranted,
    requestPermissions,
    openNotificationSettings,
    unregisterDevice,
    prepareWorkspaceSwitch,
  } = useNotifications();
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [notifBusy, setNotifBusy] = useState(false);
  const router = useRouter();

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

  const handleSwitchWorkspace = async (clerkOrgId: string) => {
    if (switchingId) return;
    setSwitchingId(clerkOrgId);
    try {
      await prepareWorkspaceSwitch();
      await switchWorkspace(clerkOrgId);
    } catch (err) {
      console.error('Failed to switch workspace:', err);
    } finally {
      setSwitchingId(null);
    }
  };

  const handleSignOut = async () => {
    await unregisterDevice();
    await signOut();
  };

  const handleNotifications = async () => {
    if (isPermissionGranted) {
      await openNotificationSettings();
      return;
    }
    setNotifBusy(true);
    try {
      const ok = await requestPermissions();
      if (!ok) await openNotificationSettings();
    } finally {
      setNotifBusy(false);
    }
  };

  return (
    <Screen header={<ScreenHeader title="Settings" onBack={() => router.back()} />}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <SectionLabel>Account</SectionLabel>
        <Card style={styles.card}>
          <View style={[styles.row, { borderBottomColor: colors.border }]}>
            <Text style={[styles.label, { color: colors.text }]}>{user?.fullName || user?.email || 'User'}</Text>
            <Text style={[styles.value, { color: colors.mutedForeground }]}>{user?.email}</Text>
          </View>
          {currentWorkspace ? (
            <View style={[styles.row, { borderBottomWidth: 0 }]}>
              <Text style={[styles.label, { color: colors.text }]}>Workspace</Text>
              <Text style={[styles.value, { color: colors.mutedForeground }]}>{currentWorkspace.name}</Text>
            </View>
          ) : null}
        </Card>

        {workspaces.length > 1 ? (
          <>
            <SectionLabel>Workspace</SectionLabel>
            <Card style={styles.card}>
              {workspaces.map((ws, i) => {
                const isActive = currentWorkspace?.clerkOrgId === ws.clerkOrgId;
                const isLast = i === workspaces.length - 1;
                const isSwitching = switchingId === ws.clerkOrgId;
                return (
                  <TouchableOpacity
                    key={ws.id}
                    style={[styles.row, !isLast ? { borderBottomColor: colors.border } : { borderBottomWidth: 0 }]}
                    onPress={() => !isActive && handleSwitchWorkspace(ws.clerkOrgId)}
                    activeOpacity={isActive ? 1 : 0.6}
                  >
                    <View style={styles.rowLeft}>
                      <View
                        style={[
                          styles.iconTile,
                          { backgroundColor: isActive ? BRAND_TINT : tint(ACCENTS.settings) },
                        ]}
                      >
                        <Building2 size={16} color={isActive ? BRAND : colors.muted} strokeWidth={2.2} />
                      </View>
                      <Text style={[styles.label, { color: colors.text }, isActive && { fontWeight: '600' }]}>
                        {ws.name}
                      </Text>
                    </View>
                    {isSwitching ? (
                      <Spinner size="small" color={BRAND} />
                    ) : isActive ? (
                      <View style={[styles.checkCircle, { backgroundColor: BRAND }]}>
                        <Check size={14} color="#FFFFFF" strokeWidth={3} />
                      </View>
                    ) : (
                      <View style={[styles.emptyCircle, { borderColor: colors.border }]} />
                    )}
                  </TouchableOpacity>
                );
              })}
            </Card>
          </>
        ) : null}

        <SectionLabel>Notifications</SectionLabel>
        <Card style={styles.card}>
          <TouchableOpacity
            style={[styles.row, { borderBottomWidth: 0 }]}
            onPress={handleNotifications}
            activeOpacity={0.6}
            disabled={notifBusy}
          >
            <View style={styles.rowLeft}>
              <View style={[styles.iconTile, { backgroundColor: tint(ACCENTS.mention) }]}>
                <Bell size={18} color={isPermissionGranted ? BRAND : colors.muted} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={[styles.label, { color: colors.text }]}>Push notifications</Text>
                <Text style={[styles.value, { color: colors.mutedForeground, marginLeft: 0 }]}>
                  {isPermissionGranted ? 'Enabled' : 'Tap to enable'}
                </Text>
              </View>
            </View>
            {notifBusy ? <Spinner size="small" color={BRAND} /> : null}
          </TouchableOpacity>
        </Card>

        <SectionLabel>Appearance</SectionLabel>
        <Card style={styles.card}>
          <TouchableOpacity style={[styles.row, { borderBottomWidth: 0 }]} onPress={toggleTheme} activeOpacity={0.6}>
            <View style={styles.rowLeft}>
              <View style={[styles.iconTile, { backgroundColor: tint(ACCENTS.settings) }]}>
                {theme === 'dark' ? (
                  <Moon size={18} color={colors.muted} />
                ) : (
                  <Sun size={18} color={colors.muted} />
                )}
              </View>
              <Text style={[styles.label, { color: colors.text }]}>Dark Mode</Text>
            </View>
            <Switch
              value={theme === 'dark'}
              onValueChange={toggleTheme}
              trackColor={{ false: colors.border, true: BRAND }}
              thumbColor="#FFFFFF"
            />
          </TouchableOpacity>
        </Card>

        <SectionLabel>About</SectionLabel>
        <Card style={styles.card}>
          {aboutRows.map((r, i) => (
            <View
              key={r.label}
              style={[
                styles.row,
                i === aboutRows.length - 1 ? { borderBottomWidth: 0 } : { borderBottomColor: colors.border },
              ]}
            >
              <Text style={[styles.label, { color: colors.text }]}>{r.label}</Text>
              <Text style={[styles.value, { color: colors.mutedForeground }]} numberOfLines={1}>
                {r.value}
              </Text>
            </View>
          ))}
        </Card>

        <TouchableOpacity
          style={[styles.signOutButton, { borderColor: colors.border }]}
          onPress={handleSignOut}
          activeOpacity={0.6}
        >
          <LogOut size={18} color={colors.destructive} />
          <Text style={[styles.signOutText, { color: colors.destructive }]}>Sign Out</Text>
        </TouchableOpacity>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: 40 },
  card: { marginHorizontal: 16, borderRadius: 16, overflow: 'hidden', paddingVertical: 0 },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowLeft: { flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1, minWidth: 0 },
  iconTile: {
    width: 34,
    height: 34,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  label: { fontSize: 16, fontWeight: '400', flexShrink: 1 },
  value: { fontSize: 14, fontWeight: '400', marginLeft: 12, flexShrink: 1 },
  checkCircle: {
    width: 24,
    height: 24,
    borderRadius: 7,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyCircle: {
    width: 24,
    height: 24,
    borderRadius: 7,
    borderWidth: 1.5,
  },
  signOutButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginHorizontal: 16,
    marginTop: 24,
    paddingVertical: 14,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
  },
  signOutText: { fontSize: 16, fontWeight: '600' },
});
