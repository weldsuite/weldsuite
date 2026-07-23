import React, { useState, useEffect, useCallback } from 'react';
import {
  StyleSheet,
  ScrollView,
  View,
  Text,
  Switch,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  Bell,
  BellOff,
  Volume2,
  VolumeX,
  Mail,
  Smartphone,
  Headphones,
  Users,
  Warehouse,
  ShoppingCart,
  FolderKanban,
  Package,
  Workflow,
  LucideIcon,
  MailIcon,
} from 'lucide-react-native';
import { useTheme } from '@/contexts/ThemeContext';
import { useToast } from '@/contexts/ToastContext';
import api, {
  NotificationPreferences,
  ModuleChannelPreferences,
} from '@/services/api';

// Module definitions matching platform app
const NOTIFICATION_MODULES: Array<{ key: string; label: string; icon: LucideIcon }> = [
  { key: 'helpdesk', label: 'Helpdesk', icon: Headphones },
  { key: 'crm', label: 'CRM', icon: Users },
  { key: 'wms', label: 'Warehouse', icon: Warehouse },
  { key: 'commerce', label: 'Commerce', icon: ShoppingCart },
  { key: 'mail', label: 'Mail', icon: MailIcon },
  { key: 'projects', label: 'Projects', icon: FolderKanban },
  { key: 'parcel', label: 'Parcel', icon: Package },
  { key: 'task', label: 'Workflows', icon: Workflow },
];

const DEFAULT_PREFERENCES: NotificationPreferences = {
  doNotDisturb: false,
  soundEnabled: true,
  defaultInApp: true,
  defaultEmail: false,
  defaultPush: true,
  defaultDesktop: true,
  modulePreferences: {},
};

export default function NotificationPreferencesScreen() {
  const { colors } = useTheme();
  const toast = useToast();
  const [preferences, setPreferences] = useState<NotificationPreferences>(DEFAULT_PREFERENCES);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const fetchPreferences = useCallback(async () => {
    try {
      const response = await api.getNotificationPreferences();
      if (response.success && response.data) {
        setPreferences({
          doNotDisturb: response.data.doNotDisturb ?? false,
          soundEnabled: response.data.soundEnabled ?? true,
          defaultInApp: response.data.defaultInApp ?? true,
          defaultEmail: response.data.defaultEmail ?? false,
          defaultPush: response.data.defaultPush ?? true,
          defaultDesktop: response.data.defaultDesktop ?? true,
          modulePreferences: response.data.modulePreferences ?? {},
        });
      }
    } catch (error) {
      console.error('Failed to fetch notification preferences:', error);
      toast.error('Failed to load preferences');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    fetchPreferences();
  }, [fetchPreferences]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchPreferences();
    setRefreshing(false);
  }, [fetchPreferences]);

  const handleGlobalChange = async (key: 'doNotDisturb' | 'soundEnabled', value: boolean) => {
    const previousValue = preferences[key];
    setPreferences((prev) => ({ ...prev, [key]: value }));

    try {
      setSaving(true);
      const response = await api.updateGlobalNotificationSettings({ [key]: value });
      if (!response.success) {
        setPreferences((prev) => ({ ...prev, [key]: previousValue }));
        toast.error(response.error || 'Failed to update setting');
      }
    } catch (error) {
      setPreferences((prev) => ({ ...prev, [key]: previousValue }));
      toast.error('Failed to update setting');
    } finally {
      setSaving(false);
    }
  };

  const handleDefaultChange = async (channel: 'inApp' | 'email' | 'push', value: boolean) => {
    const fullKey = `default${channel.charAt(0).toUpperCase() + channel.slice(1)}` as keyof NotificationPreferences;
    const previousValue = preferences[fullKey];
    setPreferences((prev) => ({ ...prev, [fullKey]: value }));

    try {
      setSaving(true);
      const response = await api.updateNotificationPreferences({ [fullKey]: value });
      if (!response.success) {
        setPreferences((prev) => ({ ...prev, [fullKey]: previousValue }));
        toast.error(response.error || 'Failed to update setting');
      }
    } catch (error) {
      setPreferences((prev) => ({ ...prev, [fullKey]: previousValue }));
      toast.error('Failed to update setting');
    } finally {
      setSaving(false);
    }
  };

  const handleModuleToggle = async (moduleKey: string, enabled: boolean) => {
    const currentPrefs = preferences.modulePreferences[moduleKey as keyof typeof preferences.modulePreferences] ?? {
      enabled: true,
      inApp: preferences.defaultInApp,
      email: preferences.defaultEmail,
      push: preferences.defaultPush,
      desktop: preferences.defaultDesktop,
    };
    const newPrefs: ModuleChannelPreferences = { ...currentPrefs, enabled };

    setPreferences((prev) => ({
      ...prev,
      modulePreferences: {
        ...prev.modulePreferences,
        [moduleKey]: newPrefs,
      },
    }));

    try {
      setSaving(true);
      const response = await api.updateModuleNotificationPreferences(moduleKey, newPrefs);
      if (!response.success) {
        setPreferences((prev) => ({
          ...prev,
          modulePreferences: {
            ...prev.modulePreferences,
            [moduleKey]: currentPrefs,
          },
        }));
        toast.error(response.error || 'Failed to update module preferences');
      }
    } catch (error) {
      setPreferences((prev) => ({
        ...prev,
        modulePreferences: {
          ...prev.modulePreferences,
          [moduleKey]: currentPrefs,
        },
      }));
      toast.error('Failed to update module preferences');
    } finally {
      setSaving(false);
    }
  };

  const getModuleEnabled = (moduleKey: string): boolean => {
    return preferences.modulePreferences[moduleKey as keyof typeof preferences.modulePreferences]?.enabled ?? true;
  };

  if (loading) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={['bottom']}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={colors.text} />
          <Text style={[styles.loadingText, { color: colors.muted }]}>Loading preferences...</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={['bottom']}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={colors.text}
          />
        }
      >
        {/* Global Settings */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>Global Settings</Text>

          <View style={[styles.settingItem, { borderBottomColor: colors.divider }]}>
            <View style={styles.settingRow}>
              {preferences.doNotDisturb ? (
                <BellOff size={18} color={colors.muted} />
              ) : (
                <Bell size={18} color={colors.muted} />
              )}
              <View style={styles.settingContent}>
                <Text style={[styles.settingLabel, { color: colors.text }]}>Do Not Disturb</Text>
                <Text style={[styles.settingDescription, { color: colors.muted }]}>
                  Pause all notifications
                </Text>
              </View>
            </View>
            <Switch
              value={preferences.doNotDisturb}
              onValueChange={(v) => handleGlobalChange('doNotDisturb', v)}
              trackColor={{ false: colors.divider, true: colors.text }}
              thumbColor={colors.background}
              ios_backgroundColor={colors.divider}
              disabled={saving}
            />
          </View>

          <View style={[styles.settingItem, { borderBottomColor: colors.divider }]}>
            <View style={styles.settingRow}>
              {preferences.soundEnabled ? (
                <Volume2 size={18} color={colors.muted} />
              ) : (
                <VolumeX size={18} color={colors.muted} />
              )}
              <View style={styles.settingContent}>
                <Text style={[styles.settingLabel, { color: colors.text }]}>Notification Sound</Text>
                <Text style={[styles.settingDescription, { color: colors.muted }]}>
                  Play sound when notifications arrive
                </Text>
              </View>
            </View>
            <Switch
              value={preferences.soundEnabled}
              onValueChange={(v) => handleGlobalChange('soundEnabled', v)}
              trackColor={{ false: colors.divider, true: colors.text }}
              thumbColor={colors.background}
              ios_backgroundColor={colors.divider}
              disabled={saving}
            />
          </View>
        </View>

        {/* Separator */}
        <View style={[styles.separator, { backgroundColor: colors.divider }]} />

        {/* Default Channels */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>Default Channels</Text>

          <View style={[styles.settingItem, { borderBottomColor: colors.divider }]}>
            <View style={styles.settingRow}>
              <Bell size={18} color={colors.muted} />
              <Text style={[styles.settingLabel, { color: colors.text }]}>In-App</Text>
            </View>
            <Switch
              value={preferences.defaultInApp}
              onValueChange={(v) => handleDefaultChange('inApp', v)}
              trackColor={{ false: colors.divider, true: colors.text }}
              thumbColor={colors.background}
              ios_backgroundColor={colors.divider}
              disabled={saving || preferences.doNotDisturb}
            />
          </View>

          <View style={[styles.settingItem, { borderBottomColor: colors.divider }]}>
            <View style={styles.settingRow}>
              <Mail size={18} color={colors.muted} />
              <Text style={[styles.settingLabel, { color: colors.text }]}>Email</Text>
            </View>
            <Switch
              value={preferences.defaultEmail}
              onValueChange={(v) => handleDefaultChange('email', v)}
              trackColor={{ false: colors.divider, true: colors.text }}
              thumbColor={colors.background}
              ios_backgroundColor={colors.divider}
              disabled={saving || preferences.doNotDisturb}
            />
          </View>

          <View style={[styles.settingItem, { borderBottomColor: colors.divider }]}>
            <View style={styles.settingRow}>
              <Smartphone size={18} color={colors.muted} />
              <Text style={[styles.settingLabel, { color: colors.text }]}>Push</Text>
            </View>
            <Switch
              value={preferences.defaultPush}
              onValueChange={(v) => handleDefaultChange('push', v)}
              trackColor={{ false: colors.divider, true: colors.text }}
              thumbColor={colors.background}
              ios_backgroundColor={colors.divider}
              disabled={saving || preferences.doNotDisturb}
            />
          </View>
        </View>

        {/* Separator */}
        <View style={[styles.separator, { backgroundColor: colors.divider }]} />

        {/* Module Notifications */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>Module Notifications</Text>

          {NOTIFICATION_MODULES.map((module) => {
            const Icon = module.icon;
            const enabled = getModuleEnabled(module.key);
            return (
              <View
                key={module.key}
                style={[styles.settingItem, { borderBottomColor: colors.divider }]}
              >
                <View style={styles.settingRow}>
                  <Icon size={18} color={colors.muted} />
                  <Text style={[styles.settingLabel, { color: colors.text }]}>{module.label}</Text>
                </View>
                <Switch
                  value={enabled}
                  onValueChange={(v) => handleModuleToggle(module.key, v)}
                  trackColor={{ false: colors.divider, true: colors.text }}
                  thumbColor={colors.background}
                  ios_backgroundColor={colors.divider}
                  disabled={saving || preferences.doNotDisturb}
                />
              </View>
            );
          })}
        </View>

        {/* Bottom spacing */}
        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
  },
  loadingText: {
    fontSize: 14,
  },
  section: {
    marginTop: 20,
    paddingHorizontal: 16,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 12,
    letterSpacing: 0.3,
    textTransform: 'uppercase',
  },
  separator: {
    height: 0.5,
    marginTop: 20,
    marginHorizontal: 16,
  },
  settingItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 14,
    borderBottomWidth: 0.5,
  },
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    flex: 1,
  },
  settingContent: {
    flex: 1,
    gap: 2,
    paddingRight: 12,
  },
  settingLabel: {
    fontSize: 15,
    fontWeight: '400',
  },
  settingDescription: {
    fontSize: 12,
    fontWeight: '400',
  },
});
