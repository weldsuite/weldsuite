import { Tabs, useRouter } from 'expo-router';
import { LayoutDashboard, FileText, Camera, Receipt, MoreHorizontal } from 'lucide-react-native';
import { View, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useOfflineQueue } from '@/contexts/OfflineQueueContext';

function ScanButton({ onPress }: { onPress: () => void }) {
  const { queue } = useOfflineQueue();

  return (
    <TouchableOpacity onPress={onPress} style={styles.scanButton} activeOpacity={0.8}>
      <View style={styles.scanButtonInner}>
        <Camera size={28} color="#fff" strokeWidth={2.5} />
      </View>
      {queue.length > 0 && (
        <View style={styles.badge}>
          <View style={styles.badgeDot} />
        </View>
      )}
    </TouchableOpacity>
  );
}

export default function TabLayout() {
  const { colors } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: '#10B981',
        tabBarInactiveTintColor: colors.muted,
        tabBarStyle: {
          backgroundColor: colors.background,
          borderTopColor: colors.divider,
          height: 56 + insets.bottom,
          paddingBottom: insets.bottom,
        },
        tabBarLabelStyle: {
          fontSize: 11,
          fontWeight: '500',
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          tabBarIcon: ({ color, size }) => <LayoutDashboard size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="invoices"
        options={{
          title: 'Invoices',
          tabBarIcon: ({ color, size }) => <FileText size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="scan-placeholder"
        options={{
          title: 'Scan',
          tabBarButton: () => (
            <ScanButton onPress={() => router.push('/scan')} />
          ),
        }}
        listeners={{
          tabPress: (e) => {
            e.preventDefault();
            router.push('/scan');
          },
        }}
      />
      <Tabs.Screen
        name="expenses"
        options={{
          title: 'Expenses',
          tabBarIcon: ({ color, size }) => <Receipt size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="more"
        options={{
          title: 'More',
          tabBarIcon: ({ color, size }) => <MoreHorizontal size={size} color={color} />,
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  scanButton: {
    top: -16,
    justifyContent: 'center',
    alignItems: 'center',
    width: 64,
    height: 64,
  },
  scanButtonInner: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#10B981',
    justifyContent: 'center',
    alignItems: 'center',
    ...Platform.select({
      ios: {
        shadowColor: '#10B981',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.3,
        shadowRadius: 8,
      },
      android: {
        elevation: 8,
      },
    }),
  },
  badge: {
    position: 'absolute',
    top: -8,
    right: 8,
  },
  badgeDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#EF4444',
    borderWidth: 2,
    borderColor: '#fff',
  },
});
