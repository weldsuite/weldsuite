import React, { useState, useCallback } from 'react';
import {
  StyleSheet,
  ScrollView,
  Pressable,
  View,
  Text,
  Switch,
  ActivityIndicator,
  RefreshControl,
  Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ChevronRight } from 'lucide-react-native';
import Constants from 'expo-constants';
import { useClerkAuth } from '@/contexts/ClerkAuthContext';
import { useWorkspace } from '@/contexts/WorkspaceContext';
import { router } from 'expo-router';
import { useTheme } from '@/contexts/ThemeContext';
import { useToast } from '@/contexts/ToastContext';
import { WorkspaceSwitcher } from '@/components/WorkspaceSwitcher';
import { ConfirmModal } from '@/components/ConfirmModal';
import storage from '@/utils/storage';
import { haptics } from '@/utils/haptics';

// Get app info from Expo Constants
const APP_VERSION = Constants.expoConfig?.version || '1.0.0';
const APP_NAME = Constants.expoConfig?.name || 'WeldSuite';
const BUILD_NUMBER = Constants.expoConfig?.ios?.buildNumber || Constants.expoConfig?.android?.versionCode || '1';

export default function SettingsScreen() {
  const { user, signOut } = useClerkAuth();
  const { refreshWorkspace, refreshWorkspaces } = useWorkspace();
  const { theme, colors, setTheme } = useTheme();
  const toast = useToast();
  const [loading, setLoading] = useState(false);
  const [clearingCache, setClearingCache] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [showClearCacheModal, setShowClearCacheModal] = useState(false);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([refreshWorkspace(), refreshWorkspaces()]);
    setRefreshing(false);
  }, [refreshWorkspace, refreshWorkspaces]);

  const handleThemeChange = async (value: boolean) => {
    haptics.selection();
    const newTheme = value ? 'dark' : 'light';
    await setTheme(newTheme);
  };

  const handleClearCachePress = () => {
    haptics.medium();
    setShowClearCacheModal(true);
  };

  const handleClearCacheConfirm = async () => {
    setClearingCache(true);
    try {
      await storage.clear();
      await refreshWorkspace();
      setShowClearCacheModal(false);
      haptics.success();
      toast.success('Cache cleared successfully');
    } catch (error) {
      console.error('Error clearing cache:', error);
      haptics.error();
      toast.error('Failed to clear cache');
    } finally {
      setClearingCache(false);
    }
  };

  const handleLogout = async () => {
    haptics.medium();
    setLoading(true);
    try {
      await signOut();
      await storage.clear();
      // AuthGuard will handle the redirect automatically
    } catch (error) {
      console.error('Logout error:', error);
      haptics.error();
      toast.error('Failed to logout. Please try again.');
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <View style={[styles.centerContainer, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.text} />
        <Text style={[styles.loadingText, { color: colors.muted }]}>Logging out...</Text>
      </View>
    );
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
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
        {/* Large Title */}
        <View style={styles.header}>
          <Text style={[styles.headerTitle, { color: colors.text }]}>Settings</Text>
        </View>

        {/* User Info */}
        {user && (
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: colors.muted }]}>ACCOUNT</Text>
            <View style={[styles.groupedCard, { backgroundColor: colors.cardBackground }]}>
              <Pressable
                style={({ pressed }) => [
                  styles.row,
                  { gap: 12 },
                  pressed && { backgroundColor: colors.pressed },
                ]}
                onPress={() => router.push('/settings/profile')}
              >
                {user.imageUrl ? (
                  <Image source={{ uri: user.imageUrl }} style={styles.avatar} />
                ) : (
                  <View style={[styles.avatar, styles.avatarFallback]}>
                    <Text style={styles.avatarText}>
                      {(user.fullName || 'U').charAt(0).toUpperCase()}
                    </Text>
                  </View>
                )}
                <View style={styles.rowContent}>
                  <Text style={[styles.rowLabel, { color: colors.text }]}>{user.fullName || 'User'}</Text>
                  <Text style={[styles.rowDescription, { color: colors.muted }]}>{user.email}</Text>
                </View>
                <ChevronRight size={20} color={colors.muted} strokeWidth={1.5} />
              </Pressable>
            </View>
          </View>
        )}

        {/* Theme Settings */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.muted }]}>APPEARANCE</Text>
          <View style={[styles.groupedCard, { backgroundColor: colors.cardBackground }]}>
            <View style={styles.row}>
              <View style={styles.rowContent}>
                <Text style={[styles.rowLabel, { color: colors.text }]}>Dark Mode</Text>
              </View>
              <Switch
                value={theme === 'dark'}
                onValueChange={handleThemeChange}
                trackColor={{ false: '#E5E5EA', true: '#34C759' }}
                thumbColor="#FFFFFF"
                ios_backgroundColor="#E5E5EA"
              />
            </View>
          </View>
        </View>

        {/* Workspace Settings */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.muted }]}>WORKSPACE</Text>
          <View style={[styles.groupedCard, { backgroundColor: colors.cardBackground }]}>
            <WorkspaceSwitcher />
          </View>
        </View>

        {/* Notifications */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.muted }]}>NOTIFICATIONS</Text>
          <View style={[styles.groupedCard, { backgroundColor: colors.cardBackground }]}>
            <Pressable
              style={({ pressed }) => [
                styles.row,
                pressed && { backgroundColor: colors.pressed },
              ]}
              onPress={() => router.push('/settings/notifications')}
            >
              <View style={styles.rowContent}>
                <Text style={[styles.rowLabel, { color: colors.text }]}>Notification Preferences</Text>
                <Text style={[styles.rowDescription, { color: colors.muted }]}>
                  Configure which notifications you receive
                </Text>
              </View>
              <ChevronRight size={20} color={colors.muted} strokeWidth={1.5} />
            </Pressable>
          </View>
        </View>

        {/* App Settings */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.muted }]}>APP</Text>
          <View style={[styles.groupedCard, { backgroundColor: colors.cardBackground }]}>
            <Pressable
              style={({ pressed }) => [
                styles.row,
                styles.rowBorder,
                pressed && { backgroundColor: colors.pressed },
              ]}
              onPress={() => toast.info(`${APP_NAME} v${APP_VERSION} (Build ${BUILD_NUMBER})`)}
            >
              <View style={styles.rowContent}>
                <Text style={[styles.rowLabel, { color: colors.text }]}>Version</Text>
              </View>
              <Text style={[styles.rowValue, { color: colors.muted }]}>
                {APP_VERSION} ({BUILD_NUMBER})
              </Text>
            </Pressable>

            <Pressable
              style={({ pressed }) => [
                styles.row,
                styles.rowBorder,
                pressed && { backgroundColor: colors.pressed },
              ]}
              onPress={() => toast.info(`${APP_NAME} - Your unified business management app.`)}
            >
              <View style={styles.rowContent}>
                <Text style={[styles.rowLabel, { color: colors.text }]}>About</Text>
              </View>
              <View style={styles.rowRight}>
                <Text style={[styles.rowValue, { color: colors.muted }]}>{APP_NAME}</Text>
                <ChevronRight size={20} color={colors.muted} strokeWidth={1.5} />
              </View>
            </Pressable>

            <Pressable
              style={({ pressed }) => [
                styles.row,
                pressed && { backgroundColor: colors.pressed },
              ]}
              onPress={() => router.push('/settings/privacy')}
            >
              <View style={styles.rowContent}>
                <Text style={[styles.rowLabel, { color: colors.text }]}>Privacy & Data</Text>
              </View>
              <ChevronRight size={20} color={colors.muted} strokeWidth={1.5} />
            </Pressable>
          </View>
        </View>

        {/* Actions */}
        <View style={styles.section}>
          <View style={[styles.groupedCard, { backgroundColor: colors.cardBackground }]}>
            <Pressable
              style={({ pressed }) => [
                styles.row,
                pressed && { backgroundColor: colors.pressed },
              ]}
              onPress={handleClearCachePress}
              disabled={clearingCache}
            >
              <View style={styles.rowContent}>
                <Text style={[styles.rowLabel, { color: colors.text }]}>Clear Cache</Text>
              </View>
              {clearingCache && <ActivityIndicator size="small" color={colors.muted} />}
            </Pressable>
          </View>

          <Pressable
            style={({ pressed }) => [
              styles.logoutButton,
              pressed && { backgroundColor: '#FEE2E2' },
            ]}
            onPress={handleLogout}
          >
            <Text style={styles.logoutText}>Log Out</Text>
          </Pressable>

          <View style={{ height: 100 }} />
        </View>
      </ScrollView>

      <ConfirmModal
        visible={showClearCacheModal}
        title="Clear Cache"
        message="This will clear all cached data including stored preferences. Are you sure?"
        confirmText="Clear"
        cancelText="Cancel"
        variant="destructive"
        loading={clearingCache}
        onConfirm={handleClearCacheConfirm}
        onCancel={() => setShowClearCacheModal(false)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  centerContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    marginTop: 16,
    fontSize: 15,
  },
  header: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 8,
  },
  headerTitle: {
    fontSize: 34,
    fontWeight: '700',
    letterSpacing: 0.4,
  },
  section: {
    marginTop: 24,
    paddingHorizontal: 16,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '500',
    marginBottom: 8,
    marginLeft: 0,
    letterSpacing: -0.1,
  },
  groupedCard: {
    borderRadius: 10,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    minHeight: 44,
    paddingHorizontal: 0,
    paddingVertical: 11,
  },
  rowBorder: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#C6C6C8',
  },
  rowContent: {
    flex: 1,
    gap: 2,
  },
  rowLabel: {
    fontSize: 17,
    fontWeight: '500',
  },
  rowDescription: {
    fontSize: 15,
  },
  rowValue: {
    fontSize: 17,
  },
  rowRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  avatar: {
    width: 38,
    height: 38,
    borderRadius: 13,
  },
  avatarFallback: {
    backgroundColor: '#3B82F6',
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarText: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '600',
  },
  logoutButton: {
    marginTop: 20,
    borderWidth: 1,
    borderColor: '#FF3B30',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  logoutText: {
    fontSize: 17,
    color: '#FF3B30',
    fontWeight: '500',
  },
});
