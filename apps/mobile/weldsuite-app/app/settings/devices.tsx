import React, { useState, useEffect, useCallback } from 'react';
import {
  StyleSheet,
  ScrollView,
  View,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Device from 'expo-device';
import { useTheme } from '@/contexts/ThemeContext';
import { useToast } from '@/contexts/ToastContext';
import api from '@/services/api';

interface RegisteredDevice {
  id: string;
  token: string;
  platform: 'ios' | 'android' | 'web';
  deviceModel: string;
  osVersion: string;
  appVersion: string;
  isActive: boolean;
  lastUsedAt: string;
  createdAt: string;
}

export default function DevicesScreen() {
  const { colors } = useTheme();
  const { showToast } = useToast();
  const [devices, setDevices] = useState<RegisteredDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  // Current device info for identification
  const currentDeviceModel = Device.modelName || 'Unknown';

  const fetchDevices = useCallback(async () => {
    try {
      const response = await api.getDevices();
      if (response.success && response.data?.devices) {
        setDevices(response.data.devices);
      }
    } catch (error) {
      console.error('Failed to fetch devices:', error);
      showToast('Failed to load devices', 'error');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [showToast]);

  useEffect(() => {
    fetchDevices();
  }, [fetchDevices]);

  const handleRefresh = () => {
    setRefreshing(true);
    fetchDevices();
  };

  const handleRemoveDevice = (device: RegisteredDevice) => {
    const isCurrentDevice = device.deviceModel === currentDeviceModel;

    Alert.alert(
      'Remove Device',
      isCurrentDevice
        ? 'This is your current device. Removing it will disable push notifications until you log in again. Continue?'
        : `Remove "${device.deviceModel}" from your registered devices? This device will no longer receive push notifications.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            setRemovingId(device.id);
            try {
              const response = await api.unregisterDevice(device.token);
              if (response.success) {
                setDevices((prev) => prev.filter((d) => d.id !== device.id));
                showToast('Device removed successfully', 'success');
              } else {
                showToast('Failed to remove device', 'error');
              }
            } catch (error) {
              console.error('Error removing device:', error);
              showToast('Failed to remove device', 'error');
            } finally {
              setRemovingId(null);
            }
          },
        },
      ]
    );
  };

  const formatDate = (dateString: string) => {
    try {
      const date = new Date(dateString);
      return date.toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return 'Unknown';
    }
  };

  const getPlatformIcon = (platform: string): keyof typeof Ionicons.glyphMap => {
    switch (platform.toLowerCase()) {
      case 'ios':
        return 'logo-apple';
      case 'android':
        return 'logo-android';
      default:
        return 'phone-portrait-outline';
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={['bottom']}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={colors.text} />
          <Text style={[styles.loadingText, { color: colors.muted }]}>Loading devices...</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={['bottom']}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={colors.text} />
        }
      >
        {/* Info Section */}
        <View style={[styles.infoSection, { backgroundColor: colors.divider }]}>
          <Ionicons name="information-circle-outline" size={20} color={colors.muted} />
          <Text style={[styles.infoText, { color: colors.muted }]}>
            These devices are registered to receive push notifications for your account.
          </Text>
        </View>

        {/* Devices List */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>
            Registered Devices ({devices.length})
          </Text>

          {devices.length === 0 ? (
            <View style={styles.emptyState}>
              <Ionicons name="phone-portrait-outline" size={48} color={colors.muted} />
              <Text style={[styles.emptyTitle, { color: colors.text }]}>No Devices</Text>
              <Text style={[styles.emptyDescription, { color: colors.muted }]}>
                No devices are registered for push notifications.
              </Text>
            </View>
          ) : (
            devices.map((device) => {
              const isCurrentDevice = device.deviceModel === currentDeviceModel;
              const isRemoving = removingId === device.id;

              return (
                <View
                  key={device.id}
                  style={[styles.deviceCard, { borderColor: colors.divider }]}
                >
                  <View style={styles.deviceHeader}>
                    <View style={[styles.deviceIcon, { backgroundColor: colors.divider }]}>
                      <Ionicons
                        name={getPlatformIcon(device.platform)}
                        size={24}
                        color={colors.text}
                      />
                    </View>
                    <View style={styles.deviceInfo}>
                      <View style={styles.deviceTitleRow}>
                        <Text style={[styles.deviceName, { color: colors.text }]}>
                          {device.deviceModel}
                        </Text>
                        {isCurrentDevice && (
                          <View style={[styles.currentBadge, { backgroundColor: colors.text }]}>
                            <Text style={[styles.currentBadgeText, { color: colors.background }]}>
                              Current
                            </Text>
                          </View>
                        )}
                      </View>
                      <Text style={[styles.devicePlatform, { color: colors.muted }]}>
                        {device.platform.charAt(0).toUpperCase() + device.platform.slice(1)} {device.osVersion}
                      </Text>
                    </View>
                  </View>

                  <View style={styles.deviceMeta}>
                    <View style={styles.metaRow}>
                      <Text style={[styles.metaLabel, { color: colors.muted }]}>Last active:</Text>
                      <Text style={[styles.metaValue, { color: colors.text }]}>
                        {formatDate(device.lastUsedAt || device.createdAt)}
                      </Text>
                    </View>
                    <View style={styles.metaRow}>
                      <Text style={[styles.metaLabel, { color: colors.muted }]}>App version:</Text>
                      <Text style={[styles.metaValue, { color: colors.text }]}>
                        {device.appVersion}
                      </Text>
                    </View>
                    <View style={styles.metaRow}>
                      <Text style={[styles.metaLabel, { color: colors.muted }]}>Status:</Text>
                      <View style={styles.statusContainer}>
                        <View
                          style={[
                            styles.statusDot,
                            { backgroundColor: device.isActive ? '#4CAF50' : '#F44336' },
                          ]}
                        />
                        <Text style={[styles.metaValue, { color: colors.text }]}>
                          {device.isActive ? 'Active' : 'Inactive'}
                        </Text>
                      </View>
                    </View>
                  </View>

                  <TouchableOpacity
                    style={[styles.removeButton, { borderColor: colors.divider }]}
                    onPress={() => handleRemoveDevice(device)}
                    disabled={isRemoving}
                  >
                    {isRemoving ? (
                      <ActivityIndicator size="small" color="#F44336" />
                    ) : (
                      <>
                        <Ionicons name="trash-outline" size={16} color="#F44336" />
                        <Text style={styles.removeButtonText}>Remove Device</Text>
                      </>
                    )}
                  </TouchableOpacity>
                </View>
              );
            })
          )}
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
  infoSection: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    margin: 16,
    padding: 14,
    borderRadius: 8,
  },
  infoText: {
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
  },
  section: {
    paddingHorizontal: 16,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 16,
    letterSpacing: 0.3,
    textTransform: 'uppercase',
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: 48,
    gap: 12,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '600',
  },
  emptyDescription: {
    fontSize: 14,
    textAlign: 'center',
  },
  deviceCard: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
  },
  deviceHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 16,
  },
  deviceIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    justifyContent: 'center',
    alignItems: 'center',
  },
  deviceInfo: {
    flex: 1,
  },
  deviceTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  deviceName: {
    fontSize: 16,
    fontWeight: '600',
  },
  currentBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
  },
  currentBadgeText: {
    fontSize: 10,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  devicePlatform: {
    fontSize: 13,
    marginTop: 2,
  },
  deviceMeta: {
    gap: 8,
    marginBottom: 16,
  },
  metaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  metaLabel: {
    fontSize: 13,
  },
  metaValue: {
    fontSize: 13,
    fontWeight: '500',
  },
  statusContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  removeButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    borderWidth: 1,
    borderRadius: 8,
  },
  removeButtonText: {
    fontSize: 14,
    fontWeight: '500',
    color: '#F44336',
  },
});
