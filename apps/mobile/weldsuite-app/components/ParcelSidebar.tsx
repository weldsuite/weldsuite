import React from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Home, Package, Search, BarChart, Settings, ShoppingCart,
  CalendarCheck, RotateCcw, Box, DollarSign, PanelLeftClose
} from 'lucide-react-native';
import { useTheme } from '@/contexts/ThemeContext';
import { router, usePathname } from 'expo-router';

interface SidebarItem {
  id: string;
  label: string;
  icon: any;
  route: string;
  badge?: number;
}

const menuItems: SidebarItem[] = [
  {
    id: 'dashboard',
    label: 'Dashboard',
    icon: Home,
    route: '/parcel',
  },
  {
    id: 'orders',
    label: 'Orders',
    icon: ShoppingCart,
    route: '/parcel/orders',
  },
  {
    id: 'pickups',
    label: 'Pickups',
    icon: CalendarCheck,
    route: '/parcel/pickups',
  },
  {
    id: 'returns',
    label: 'Returns',
    icon: RotateCcw,
    route: '/parcel/returns',
  },
  {
    id: 'scan',
    label: 'Scan Package',
    icon: Search,
    route: '/parcel/scan',
  },
  {
    id: 'parcels',
    label: 'All Parcels',
    icon: Package,
    route: '/parcel/parcels',
    badge: 3,
  },
  {
    id: 'boxes',
    label: 'Boxes',
    icon: Box,
    route: '/parcel/boxes',
  },
  {
    id: 'shipping-prices',
    label: 'Shipping Prices',
    icon: DollarSign,
    route: '/parcel/shipping-prices',
  },
  {
    id: 'analytics',
    label: 'Analytics',
    icon: BarChart,
    route: '/parcel/analytics',
  },
];

interface ParcelSidebarProps {
  onCollapse?: () => void;
}

export default function ParcelSidebar({ onCollapse }: ParcelSidebarProps) {
  const { colors } = useTheme();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();

  const isActive = (route: string) => {
    return pathname === route || pathname.startsWith(route + '/');
  };

  return (
    <View style={[styles.container, { backgroundColor: '#fbfbfb' }]}>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: '#ebebeb', paddingTop: insets.top + 12 }]}>
        <Text style={styles.headerTitle}>Parcel</Text>
        {onCollapse && (
          <TouchableOpacity style={styles.collapseButton} onPress={onCollapse}>
            <PanelLeftClose size={20} color="#6B7280" strokeWidth={2} />
          </TouchableOpacity>
        )}
      </View>

      {/* Menu Items */}
      <ScrollView style={styles.menuContainer} showsVerticalScrollIndicator={false}>
        {menuItems.map((item) => {
          const Icon = item.icon;
          const active = isActive(item.route);
          
          return (
            <TouchableOpacity
              key={item.id}
              style={[
                styles.menuItem,
                active && { backgroundColor: '#f7f7f7' }
              ]}
              onPress={() => router.push(item.route)}
            >
              <View style={styles.menuItemContent}>
                <Icon 
                  size={20} 
                  color={active ? '#343434' : '#343434'} 
                  strokeWidth={2}
                />
                <Text 
                  style={[
                    styles.menuItemText, 
                    { color: active ? '#252525' : '#343434' }
                  ]}
                >
                  {item.label}
                </Text>
              </View>
              {item.badge && (
                <View style={[styles.badge, { backgroundColor: '#343434' }]}>
                  <Text style={styles.badgeText}>{item.badge}</Text>
                </View>
              )}
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {/* Bottom Actions */}
      <View style={[styles.bottomActions, { borderTopColor: '#ebebeb' }]}>
        <TouchableOpacity style={styles.bottomAction}>
          <Settings size={20} color="#343434" strokeWidth={2} />
          <Text style={[styles.bottomActionText, { color: '#343434' }]}>Settings</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: 280,
    height: '100%',
    borderRightWidth: 1,
    borderRightColor: '#ebebeb',
  },
  header: {
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: 12,
    borderBottomWidth: 1,
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#111827',
  },
  collapseButton: {
    padding: 4,
  },
  menuContainer: {
    flex: 1,
    paddingVertical: 8,
  },
  menuItem: {
    paddingHorizontal: 20,
    paddingVertical: 14,
    marginHorizontal: 12,
    marginVertical: 2,
    borderRadius: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  menuItemContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  menuItemText: {
    fontSize: 15,
    fontWeight: '500',
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
    minWidth: 24,
    alignItems: 'center',
  },
  badgeText: {
    color: '#fbfbfb',
    fontSize: 12,
    fontWeight: '600',
  },
  bottomActions: {
    borderTopWidth: 1,
    paddingVertical: 12,
    paddingHorizontal: 20,
    gap: 8,
  },
  bottomAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
  },
  bottomActionText: {
    fontSize: 14,
    fontWeight: '500',
  },
});