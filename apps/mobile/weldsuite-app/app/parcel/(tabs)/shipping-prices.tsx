import React from 'react';
import {
  StyleSheet,
  View,
  Text,
} from 'react-native';
import { useTheme } from '@/contexts/ThemeContext';
import { DollarSign } from 'lucide-react-native';

export default function ShippingPrices() {
  const { colors } = useTheme();

  return (
    <View style={[styles.container, { backgroundColor: '#FFFFFF' }]}>
      <View style={styles.emptyState}>
        <View style={[styles.iconContainer, { backgroundColor: '#F3F4F6' }]}>
          <DollarSign size={32} color="#9CA3AF" strokeWidth={1.5} />
        </View>
        <Text style={[styles.emptyTitle, { color: colors.text }]}>No Pricing Data</Text>
        <Text style={[styles.emptyDescription, { color: colors.muted }]}>
          Shipping rates and pricing information will be displayed here
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  iconContainer: {
    width: 80,
    height: 80,
    borderRadius: 40,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 24,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: '600',
    marginBottom: 8,
  },
  emptyDescription: {
    fontSize: 14,
    textAlign: 'center',
    maxWidth: 250,
  },
});