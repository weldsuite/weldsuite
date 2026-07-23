import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  TextInput,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '@/contexts/ThemeContext';
import {
  Package, Users, ClipboardList, CheckSquare,
  Headphones, Mail, Warehouse, Calculator,
  Send, Globe, Grid3X3, LucideIcon, ChevronLeft, Menu, Search, X,
} from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AppDrawer from '@/components/layout/AppDrawer';
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

export default function AppStoreScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [drawerVisible, setDrawerVisible] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

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

  const filteredApps = apps
    .filter(app => !selectedCategory || app.category === selectedCategory)
    .filter(app => !searchQuery || app.name.toLowerCase().includes(searchQuery.toLowerCase()) || app.description.toLowerCase().includes(searchQuery.toLowerCase()));

  const getIcon = (iconName: string) => {
    return iconMap[iconName] || Grid3X3;
  };

  const renderAppCard = (app: AvailableApp) => {
    const IconComponent = getIcon(app.icon);

    return (
      <TouchableOpacity
        key={app.code}
        style={[styles.appCard, { backgroundColor: colors.card, borderColor: colors.divider }]}
        onPress={() => router.push(`/app-store/${app.code}`)}
        activeOpacity={0.7}
      >
        <View style={[styles.appIcon, { backgroundColor: `${colors.text}08` }]}>
          <IconComponent size={24} color={colors.muted} strokeWidth={1.5} />
        </View>
        <View style={styles.appInfo}>
          <Text style={[styles.appName, { color: colors.text }]}>{app.name}</Text>
          <Text style={[styles.appDescription, { color: colors.muted }]} numberOfLines={2}>
            {app.description}
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
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.menuButton}
        >
          <ChevronLeft size={22} color="#374151" strokeWidth={2} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>App Store</Text>
      </View>

      {/* Search Bar */}
      <View style={styles.searchContainer}>
        <View style={[styles.searchBar, { backgroundColor: '#F3F4F6' }]}>
          <Search size={16} color="#9CA3AF" strokeWidth={2} />
          <TextInput
            style={[styles.searchInput, { color: colors.text }]}
            placeholder="Search apps..."
            placeholderTextColor="#9CA3AF"
            value={searchQuery}
            onChangeText={setSearchQuery}
          />
          {searchQuery.length > 0 && (
            <TouchableOpacity onPress={() => setSearchQuery('')}>
              <X size={18} color="#9CA3AF" strokeWidth={2} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* App Drawer */}
      <AppDrawer
        visible={drawerVisible}
        onClose={() => setDrawerVisible(false)}
        currentApp=""
        menuItems={[]}
      />

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
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
  },
  menuButton: {
    padding: 4,
  },
  headerTitle: {
    flex: 1,
    fontSize: 20,
    fontWeight: '600',
    marginLeft: 12,
  },
  searchContainer: {
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 8,
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 8,
    gap: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    fontWeight: '400',
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  categoryScroll: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 0.5,
  },
  categoryChip: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    marginRight: 8,
  },
  categoryChipActive: {
    backgroundColor: '#2563eb',
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
    borderRadius: 12,
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
