import React, { useMemo, useState, useCallback } from 'react';
import {
  StyleSheet,
  TouchableOpacity,
  Pressable,
  View,
  Text,
  FlatList,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ChevronRight, Plus } from 'lucide-react-native';
import { useTheme } from '@/contexts/ThemeContext';
import { useInstalledApps, InstalledApp } from '@/contexts/InstalledAppsContext';
import { router } from 'expo-router';
import { AppIcon, APPS_WITH_LOGOS } from '@/components/AppIcon';
import { haptics } from '@/utils/haptics';

// Route mapping for app codes
const routeMap: Record<string, string> = {
  commerce: '/commerce',
  accounting: '/accounting',
  wms: '/wms',
  crm: '/crm',
  projects: '/projects',
  helpdesk: '/helpdesk',
  mail: '/mail',
  parcel: '/parcel',
  task: '/task',
  host: '/host',
  wallet: '/wallet',
  notifications: '/(tabs)/notifications',
};

interface AppItem {
  id: string;
  appCode: string;
  name: string;
  description: string;
  route: string;
  status: string;
  displayOrder: number;
}

interface AppSection {
  title: string;
  data: AppItem[];
}

export default function AppsScreen() {
  const { colors } = useTheme();
  const { installedApps, isLoading, error, refreshApps } = useInstalledApps();
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await refreshApps();
    setRefreshing(false);
  }, [refreshApps]);

  // Transform installed apps into app items with routes, filtering to only apps with custom logos
  const appItems = useMemo(() => {
    return installedApps
      .filter(app => APPS_WITH_LOGOS.includes(app.appCode))
      .map(app => ({
        id: app.id,
        appCode: app.appCode,
        name: app.name,
        description: app.description || '',
        route: routeMap[app.appCode] || `/${app.appCode}`,
        status: app.status,
        displayOrder: app.displayOrder,
      }));
  }, [installedApps]);

  // Group apps by category
  const appSections = useMemo(() => {
    const categoryMap = new Map<string, AppItem[]>();

    appItems.forEach(app => {
      const installedApp = installedApps.find(a => a.id === app.id);
      const category = installedApp?.category || 'Other';

      if (!categoryMap.has(category)) {
        categoryMap.set(category, []);
      }
      categoryMap.get(category)!.push(app);
    });

    // Sort apps within each category by display order
    const sections: AppSection[] = [];
    categoryMap.forEach((apps, category) => {
      apps.sort((a, b) => a.displayOrder - b.displayOrder);
      sections.push({ title: category, data: apps });
    });

    // Sort sections alphabetically
    sections.sort((a, b) => a.title.localeCompare(b.title));

    return sections;
  }, [appItems, installedApps]);

  const handleAppPress = (app: AppItem) => {
    if (app.status === 'disabled') {
      return;
    }
    haptics.light();
    if (app.route) {
      router.push(app.route as any);
    }
  };

  const getStatusBadge = (status: string) => {
    if (status === 'active') return null;

    const badgeColors: Record<string, string> = {
      beta: '#F59E0B',
      disabled: '#6B7280',
    };

    const color = badgeColors[status] || '#6B7280';

    return (
      <View style={[styles.statusBadge, { backgroundColor: `${color}20` }]}>
        <Text style={[styles.statusText, { color }]}>
          {status.charAt(0).toUpperCase() + status.slice(1)}
        </Text>
      </View>
    );
  };

  const renderItem = ({ item }: { item: AppItem }) => {
    const isDisabled = item.status === 'disabled';

    return (
      <Pressable
        style={({ pressed }) => [
          styles.appItem,
          {
            backgroundColor: pressed && !isDisabled ? colors.pressed : colors.cardBackground,
            opacity: isDisabled ? 0.6 : 1,
          },
        ]}
        onPress={() => handleAppPress(item)}
        disabled={isDisabled}
      >
        <View style={styles.appContent}>
          <View style={[styles.iconContainer, { backgroundColor: `${colors.text}08` }]}>
            <AppIcon appCode={item.appCode} size={22} />
          </View>
          <View style={styles.appInfo}>
            <View style={styles.appHeader}>
              <Text style={[styles.appName, { color: colors.text }]}>{item.name}</Text>
              {getStatusBadge(item.status)}
            </View>
            <Text style={[styles.appDescription, { color: colors.muted }]}>
              {item.description}
            </Text>
          </View>
          {!isDisabled && (
            <ChevronRight size={18} color={colors.muted} strokeWidth={1.5} />
          )}
        </View>
      </Pressable>
    );
  };


  const renderEmptyComponent = () => (
    <View style={styles.emptyContainer}>
      <Text style={[styles.emptyText, { color: colors.muted }]}>
        No apps installed in this workspace
      </Text>
    </View>
  );

  if (isLoading) {
    return (
      <SafeAreaView style={[styles.container, styles.centerContent, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.text} />
        <Text style={[styles.loadingText, { color: colors.muted }]}>Loading apps...</Text>
      </SafeAreaView>
    );
  }

  if (error) {
    return (
      <SafeAreaView style={[styles.container, styles.centerContent, { backgroundColor: colors.background }]}>
        <Text style={[styles.errorText, { color: colors.text }]}>Failed to load apps</Text>
        <TouchableOpacity style={styles.retryButton} onPress={refreshApps}>
          <Text style={[styles.retryText, { color: colors.text }]}>Tap to retry</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  const handleAppStorePress = () => {
    router.push('/(tabs)/apps/store');
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={styles.header}>
        <View style={styles.headerRow}>
          <View style={styles.headerTitles}>
            <Text style={[styles.headerTitle, { color: colors.text }]}>Apps</Text>
          </View>
          <TouchableOpacity
            style={[styles.appStoreButton, { backgroundColor: colors.text }]}
            onPress={handleAppStorePress}
            activeOpacity={0.7}
          >
            <Plus size={16} color={colors.background} strokeWidth={2} />
          </TouchableOpacity>
        </View>
      </View>

      <FlatList
        data={appItems}
        renderItem={renderItem}
        keyExtractor={(item) => item.id}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={renderEmptyComponent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={colors.text}
          />
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  centerContent: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  header: {
    padding: 20,
    paddingBottom: 10,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  headerTitles: {
    flex: 1,
  },
  headerTitle: {
    fontSize: 34,
    fontWeight: '700',
    letterSpacing: 0.4,
  },
  headerSubtitle: {
    fontSize: 14,
    marginTop: 4,
  },
  appStoreButton: {
    width: 32,
    height: 32,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  listContent: {
    paddingBottom: 20,
    flexGrow: 1,
  },
  sectionHeader: {
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 8,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  appItem: {
    marginHorizontal: 20,
    marginVertical: 4,
    padding: 16,
    borderRadius: 10,
  },
  appContent: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  iconContainer: {
    width: 40,
    height: 40,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  appInfo: {
    flex: 1,
  },
  appHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 2,
  },
  appName: {
    fontSize: 17,
    fontWeight: '400',
  },
  appDescription: {
    fontSize: 15,
  },
  statusBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  statusText: {
    fontSize: 9,
    fontWeight: '600',
    textTransform: 'uppercase',
  },
  loadingText: {
    marginTop: 16,
    fontSize: 14,
  },
  errorText: {
    fontSize: 16,
    fontWeight: '500',
  },
  retryButton: {
    marginTop: 12,
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  retryText: {
    fontSize: 14,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 40,
  },
  emptyText: {
    fontSize: 14,
    textAlign: 'center',
  },
});
