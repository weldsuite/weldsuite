import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '@/contexts/ThemeContext';
import { ChevronLeft } from 'lucide-react-native';
import { AppIcon } from '@/components/AppIcon';
import api from '@/services/api';

interface AvailableApp {
  code: string;
  name: string;
  description: string;
  icon: string;
  category: string;
  provider: string;
  verified: boolean;
  isInstalled: boolean;
  path?: string;
}

const SHORT_DESCRIPTIONS: Record<string, string> = {
  crm: 'Customer management',
  commerce: 'Orders & products',
  helpdesk: 'Support tickets',
  mail: 'Email management',
  projects: 'Project management',
  task: 'Task tracking',
  host: 'Website hosting',
  parcel: 'Shipment tracking',
  accounting: 'Invoices & finance',
  wms: 'Warehouse management',
  wallet: 'Payments',
};

export default function AppStoreScreen() {
  const { colors } = useTheme();
  const router = useRouter();

  const [apps, setApps] = useState<AvailableApp[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);

  const fetchApps = useCallback(async () => {
    try {
      const data = await api.apps.getAvailable();
      // WeldAgent (AI assistant) has been removed along with the AI backend.
      // Filter it out defensively in case the catalog still returns it.
      setApps(data.filter((app) => app.code !== 'agent'));
    } catch (error) {
      console.error('Error fetching apps:', error);
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchApps();
  }, [fetchApps]);

  const onRefresh = useCallback(() => {
    setIsRefreshing(true);
    fetchApps();
  }, [fetchApps]);

  // Group apps by category
  const categories = React.useMemo(() => {
    const grouped: Record<string, AvailableApp[]> = {};
    apps.forEach((app) => {
      if (!grouped[app.category]) {
        grouped[app.category] = [];
      }
      grouped[app.category].push(app);
    });
    return grouped;
  }, [apps]);

  const categoryList = Object.keys(categories);

  const filteredApps = selectedCategory
    ? apps.filter((app) => app.category === selectedCategory)
    : apps;

  const renderAppCard = (app: AvailableApp) => {
    return (
      <TouchableOpacity
        key={app.code}
        style={[styles.appCard, { backgroundColor: colors.card, borderColor: colors.divider }]}
        onPress={() => router.push(`/(tabs)/apps/store/${app.code}` as any)}
        activeOpacity={0.7}
      >
        <View style={[styles.appIcon, { backgroundColor: `${colors.text}08` }]}>
          <AppIcon appCode={app.code} size={22} />
        </View>
        <View style={styles.appInfo}>
          <Text style={[styles.appName, { color: colors.text }]}>{app.name}</Text>
          <Text style={[styles.appDescription, { color: colors.muted }]} numberOfLines={1}>
            {SHORT_DESCRIPTIONS[app.code] || app.description}
          </Text>
        </View>
        <View style={styles.appStatus}>
          {app.isInstalled ? (
            <View style={[styles.installedBadge, { backgroundColor: '#dcfce7' }]}>
              <Text style={styles.installedText}>Installed</Text>
            </View>
          ) : (
            <View style={[styles.notInstalledBadge, { backgroundColor: `${colors.text}10` }]}>
              <Text style={[styles.notInstalledText, { color: colors.muted }]}>Get</Text>
            </View>
          )}
        </View>
      </TouchableOpacity>
    );
  };

  if (isLoading) {
    return (
      <View style={[styles.loadingContainer, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.text} />
      </View>
    );
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={['top']}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} activeOpacity={0.7} style={styles.backButton}>
          <ChevronLeft size={22} color={colors.text} strokeWidth={2} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>App Store</Text>
      </View>

      {/* Category Filter */}
      <View style={[styles.categoryBar, { borderBottomColor: colors.divider }]}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.categoryScrollContent}
        >
        <TouchableOpacity
          style={[
            styles.categoryChip,
            { borderColor: colors.divider },
            !selectedCategory && styles.categoryChipActive,
          ]}
          onPress={() => setSelectedCategory(null)}
        >
          <Text style={[
            styles.categoryText,
            { color: colors.text },
            !selectedCategory && styles.categoryTextActive,
          ]}>
            All
          </Text>
        </TouchableOpacity>
        {categoryList.map((category) => (
          <TouchableOpacity
            key={category}
            style={[
              styles.categoryChip,
              { borderColor: colors.divider },
              selectedCategory === category && styles.categoryChipActive,
            ]}
            onPress={() => setSelectedCategory(category)}
          >
            <Text
              style={[
                styles.categoryText,
                { color: colors.text },
                selectedCategory === category && styles.categoryTextActive,
              ]}
            >
              {category}
            </Text>
          </TouchableOpacity>
        ))}
        </ScrollView>
      </View>

      {/* App List */}
      <ScrollView
        style={styles.content}
        refreshControl={
          <RefreshControl refreshing={isRefreshing} onRefresh={onRefresh} />
        }
      >
        {selectedCategory ? (
          <>
            <Text style={[styles.sectionTitle, { color: colors.muted }]}>{selectedCategory}</Text>
            {filteredApps.map(renderAppCard)}
          </>
        ) : (
          Object.entries(categories).map(([category, categoryApps]) => (
            <View key={category}>
              <Text style={[styles.sectionTitle, { color: colors.muted }]}>{category}</Text>
              {categoryApps.map(renderAppCard)}
            </View>
          ))
        )}
        <View style={{ height: 32 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 12,
    gap: 12,
  },
  backButton: {
    padding: 4,
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: '600',
    letterSpacing: -0.5,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  categoryBar: {
    borderBottomWidth: 0.5,
    paddingVertical: 12,
  },
  categoryScrollContent: {
    paddingHorizontal: 16,
    alignItems: 'center',
    gap: 8,
  },
  categoryChip: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
  },
  categoryChipActive: {
    backgroundColor: '#2563eb',
    borderColor: '#2563eb',
  },
  categoryText: {
    fontSize: 14,
  },
  categoryTextActive: {
    color: '#fff',
    fontWeight: '600',
  },
  content: {
    padding: 16,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 12,
    marginTop: 16,
  },
  appCard: {
    flexDirection: 'row',
    padding: 16,
    borderRadius: 12,
    marginBottom: 12,
    borderWidth: 0.5,
  },
  appIcon: {
    width: 48,
    height: 48,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  appInfo: {
    flex: 1,
  },
  appName: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 4,
  },
  appDescription: {
    fontSize: 13,
    lineHeight: 18,
  },
  appStatus: {
    justifyContent: 'center',
    marginLeft: 12,
  },
  installedBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
  },
  installedText: {
    fontSize: 12,
    fontWeight: '500',
    color: '#16a34a',
  },
  notInstalledBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  notInstalledText: {
    fontSize: 12,
    fontWeight: '500',
  },
});
