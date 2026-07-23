import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { useTheme } from '@/contexts/ThemeContext';
import { useToast } from '@/contexts/ToastContext';
import {
  Package, Users, ClipboardList, CheckSquare,
  Headphones, Mail, Warehouse, Calculator,
  Send, Globe, Grid3X3, LucideIcon, CheckCircle,
} from 'lucide-react-native';
import api from '@/services/api';
import { useInstalledApps } from '@/contexts/InstalledAppsContext';
import { ConfirmModal } from '@/components/ConfirmModal';

interface AppDetail {
  code: string;
  name: string;
  description: string;
  overview?: string;
  icon: string;
  category: string;
  provider: string;
  verified: boolean;
  isInstalled: boolean;
  path?: string;
  features?: string[];
}

// Map icon names to Lucide icons
const iconMap: Record<string, LucideIcon> = {
  'shopping-cart': Package,
  'users': Users,
  'clipboard-list': ClipboardList,
  'check-square': CheckSquare,
  'headphones': Headphones,
  'mail': Mail,
  'package': Warehouse,
  'calculator': Calculator,
  'truck': Send,
  'server': Globe,
  'folder': ClipboardList,
};

export default function AppDetailScreen() {
  const { appCode } = useLocalSearchParams<{ appCode: string }>();
  const { colors } = useTheme();
  const toast = useToast();
  const router = useRouter();
  const { refreshApps } = useInstalledApps();

  const [app, setApp] = useState<AppDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isInstalling, setIsInstalling] = useState(false);
  const [showUninstallModal, setShowUninstallModal] = useState(false);

  const fetchApp = useCallback(async () => {
    if (!appCode) {
      console.error('No appCode provided');
      setApp(null);
      setIsLoading(false);
      return;
    }

    try {
      const foundApp = await api.apps.getByCode(appCode);
      setApp(foundApp);
    } catch (error) {
      console.error('Error fetching app:', error);
      setApp(null);
    } finally {
      setIsLoading(false);
    }
  }, [appCode]);

  useEffect(() => {
    fetchApp();
  }, [fetchApp]);

  const handleInstall = async () => {
    if (!app) return;

    setIsInstalling(true);
    try {
      await api.apps.install(app.code);
      setApp((prev) => (prev ? { ...prev, isInstalled: true } : null));
      refreshApps(); // Refresh installed apps list
      toast.success(`${app.name} has been installed`);
    } catch (error) {
      toast.error('Failed to install app');
    } finally {
      setIsInstalling(false);
    }
  };

  const handleUninstallPress = () => {
    setShowUninstallModal(true);
  };

  const handleUninstallConfirm = async () => {
    if (!app) return;

    setIsInstalling(true);
    try {
      await api.apps.uninstall(app.code);
      setApp((prev) => (prev ? { ...prev, isInstalled: false } : null));
      refreshApps();
      setShowUninstallModal(false);
      toast.success(`${app.name} has been uninstalled`);
    } catch (error) {
      toast.error('Failed to uninstall app');
    } finally {
      setIsInstalling(false);
    }
  };

  const getIcon = (iconName: string) => {
    return iconMap[iconName] || Grid3X3;
  };

  if (isLoading) {
    return (
      <View style={[styles.loadingContainer, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.text} />
      </View>
    );
  }

  if (!app) {
    return (
      <View style={[styles.notFound, { backgroundColor: colors.background }]}>
        <Text style={[styles.notFoundText, { color: colors.muted }]}>App not found</Text>
      </View>
    );
  }

  const IconComponent = getIcon(app.icon);

  return (
    <>
      <Stack.Screen options={{ title: app.name }} />
      <ScrollView style={[styles.container, { backgroundColor: colors.background }]}>
        {/* Header */}
        <View style={[styles.header, { backgroundColor: colors.card, borderBottomColor: colors.divider }]}>
          <View style={[styles.iconContainer, { backgroundColor: `${colors.text}08` }]}>
            <IconComponent size={40} color={colors.muted} strokeWidth={1.5} />
          </View>
          <Text style={[styles.appName, { color: colors.text }]}>{app.name}</Text>
          <Text style={[styles.category, { color: colors.muted }]}>{app.category}</Text>
          <TouchableOpacity
            style={[
              styles.button,
              app.isInstalled ? [styles.uninstallButton, { backgroundColor: `${colors.text}10` }] : styles.installButton,
            ]}
            onPress={app.isInstalled ? handleUninstallPress : handleInstall}
            disabled={isInstalling}
            activeOpacity={0.7}
          >
            {isInstalling ? (
              <ActivityIndicator size="small" color={app.isInstalled ? colors.muted : '#fff'} />
            ) : (
              <Text
                style={[
                  styles.buttonText,
                  app.isInstalled && [styles.uninstallButtonText, { color: colors.muted }],
                ]}
              >
                {app.isInstalled ? 'Uninstall' : 'Install'}
              </Text>
            )}
          </TouchableOpacity>
        </View>

        {/* Content */}
        <View style={styles.content}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>Description</Text>
          <Text style={[styles.description, { color: colors.muted }]}>
            {app.overview || app.description}
          </Text>

          {app.features && app.features.length > 0 && (
            <>
              <Text style={[styles.sectionTitle, { color: colors.text }]}>Features</Text>
              {app.features.map((feature, index) => (
                <View key={index} style={styles.featureRow}>
                  <CheckCircle size={16} color="#16a34a" strokeWidth={2} />
                  <Text style={[styles.featureText, { color: colors.muted }]}>{feature}</Text>
                </View>
              ))}
            </>
          )}

          <Text style={[styles.sectionTitle, { color: colors.text, marginTop: 24 }]}>Information</Text>
          <View style={[styles.infoRow, { borderBottomColor: colors.divider }]}>
            <Text style={[styles.infoLabel, { color: colors.muted }]}>Provider</Text>
            <Text style={[styles.infoValue, { color: colors.text }]}>{app.provider}</Text>
          </View>
          <View style={[styles.infoRow, { borderBottomColor: colors.divider }]}>
            <Text style={[styles.infoLabel, { color: colors.muted }]}>Category</Text>
            <Text style={[styles.infoValue, { color: colors.text }]}>{app.category}</Text>
          </View>
          <View style={[styles.infoRow, { borderBottomColor: colors.divider }]}>
            <Text style={[styles.infoLabel, { color: colors.muted }]}>Status</Text>
            {app.verified ? (
              <View style={styles.verifiedBadge}>
                <CheckCircle size={16} color="#16a34a" strokeWidth={2} />
                <Text style={styles.verifiedText}>Verified</Text>
              </View>
            ) : (
              <Text style={[styles.infoValue, { color: colors.text }]}>Not verified</Text>
            )}
          </View>
        </View>
        <View style={{ height: 32 }} />
      </ScrollView>

      <ConfirmModal
        visible={showUninstallModal}
        title={`Uninstall ${app.name}?`}
        message="This will remove the app from your workspace."
        confirmText="Uninstall"
        cancelText="Cancel"
        variant="destructive"
        loading={isInstalling}
        onConfirm={handleUninstallConfirm}
        onCancel={() => setShowUninstallModal(false)}
      />
    </>
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
  },
  notFound: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  notFoundText: {
    fontSize: 16,
    textAlign: 'center',
  },
  header: {
    padding: 24,
    borderBottomWidth: 0.5,
    alignItems: 'center',
  },
  iconContainer: {
    width: 80,
    height: 80,
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 16,
  },
  appName: {
    fontSize: 24,
    fontWeight: '600',
    marginBottom: 8,
    textAlign: 'center',
  },
  category: {
    fontSize: 14,
    marginBottom: 16,
  },
  button: {
    paddingHorizontal: 32,
    paddingVertical: 12,
    borderRadius: 24,
    minWidth: 160,
    alignItems: 'center',
  },
  installButton: {
    backgroundColor: '#2563eb',
  },
  uninstallButton: {},
  buttonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#fff',
  },
  uninstallButtonText: {},
  content: {
    padding: 24,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 12,
  },
  description: {
    fontSize: 15,
    lineHeight: 22,
    marginBottom: 24,
  },
  featureRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
    gap: 10,
  },
  featureText: {
    fontSize: 15,
    flex: 1,
  },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 12,
    borderBottomWidth: 0.5,
  },
  infoLabel: {
    fontSize: 15,
  },
  infoValue: {
    fontSize: 15,
    fontWeight: '500',
  },
  verifiedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  verifiedText: {
    fontSize: 15,
    color: '#16a34a',
    fontWeight: '500',
  },
});
