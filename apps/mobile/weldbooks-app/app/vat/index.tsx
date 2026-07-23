import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  SafeAreaView,
  RefreshControl,
} from 'react-native';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import api from '@/services/api';
import { formatCurrency } from '@/lib/currency';
import { ChevronLeft, ChevronRight } from 'lucide-react-native';

type VatReturn = {
  id: string;
  period: string;
  year: number;
  status: 'draft' | 'submitted' | 'accepted' | 'rejected';
  netAmount: number;
  currency: string;
};

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  draft: { bg: 'rgba(107,114,128,0.12)', text: '#6B7280' },
  submitted: { bg: 'rgba(59,130,246,0.12)', text: '#3B82F6' },
  accepted: { bg: 'rgba(16,185,129,0.12)', text: '#10B981' },
  rejected: { bg: 'rgba(239,68,68,0.12)', text: '#EF4444' },
};

export default function VatReturnsScreen() {
  const router = useRouter();
  const { colors } = useTheme();

  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState(currentYear);
  const [returns, setReturns] = useState<VatReturn[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchReturns = useCallback(async () => {
    try {
      setError(null);
      const data = await api.getVatReturns({ year });
      setReturns(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load VAT returns');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [year]);

  useEffect(() => {
    setLoading(true);
    fetchReturns();
  }, [fetchReturns]);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    fetchReturns();
  }, [fetchReturns]);

  const handleYearChange = (delta: number) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setYear((prev) => prev + delta);
  };

  const handleReturnPress = (id: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push(`/vat/${id}` as any);
  };

  const renderReturn = ({ item }: { item: VatReturn }) => {
    const statusStyle = STATUS_COLORS[item.status] || STATUS_COLORS.draft;
    return (
      <TouchableOpacity
        style={[styles.returnCard, { backgroundColor: colors.cardBackground }]}
        onPress={() => handleReturnPress(item.id)}
        activeOpacity={0.6}
      >
        <View style={styles.returnLeft}>
          <Text style={[styles.returnPeriod, { color: colors.text }]}>{item.period}</Text>
          <View style={[styles.statusBadge, { backgroundColor: statusStyle.bg }]}>
            <Text style={[styles.statusText, { color: statusStyle.text }]}>
              {item.status.charAt(0).toUpperCase() + item.status.slice(1)}
            </Text>
          </View>
        </View>
        <View style={styles.returnRight}>
          <Text style={[styles.returnAmount, { color: colors.text }]}>
            {formatCurrency(item.netAmount, item.currency)}
          </Text>
          <ChevronRight size={16} color={colors.muted} />
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <ChevronLeft size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>VAT Returns</Text>
        <View style={styles.headerSpacer} />
      </View>

      {/* Year selector */}
      <View style={styles.yearSelector}>
        <TouchableOpacity onPress={() => handleYearChange(-1)} style={styles.yearButton}>
          <ChevronLeft size={20} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.yearText, { color: colors.text }]}>{year}</Text>
        <TouchableOpacity
          onPress={() => handleYearChange(1)}
          style={styles.yearButton}
          disabled={year >= currentYear}
        >
          <ChevronRight size={20} color={year >= currentYear ? colors.muted : colors.text} />
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color="#10B981" />
        </View>
      ) : error ? (
        <View style={styles.centered}>
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.retryButton} onPress={fetchReturns}>
            <Text style={styles.retryButtonText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={returns}
          keyExtractor={(item) => item.id}
          renderItem={renderReturn}
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor="#10B981" />
          }
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Text style={[styles.emptyText, { color: colors.muted }]}>
                No VAT returns for {year}
              </Text>
            </View>
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  backButton: {
    width: 32,
    height: 32,
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerTitle: {
    flex: 1,
    fontSize: 17,
    fontWeight: '600',
    textAlign: 'center',
  },
  headerSpacer: {
    width: 32,
  },
  yearSelector: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    gap: 24,
  },
  yearButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    justifyContent: 'center',
    alignItems: 'center',
  },
  yearText: {
    fontSize: 20,
    fontWeight: '700',
  },
  listContent: {
    paddingHorizontal: 16,
    paddingBottom: 32,
  },
  returnCard: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderRadius: 12,
    padding: 16,
    marginBottom: 10,
  },
  returnLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  returnPeriod: {
    fontSize: 16,
    fontWeight: '600',
  },
  statusBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
  },
  statusText: {
    fontSize: 12,
    fontWeight: '600',
  },
  returnRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  returnAmount: {
    fontSize: 15,
    fontWeight: '600',
  },
  emptyContainer: {
    paddingVertical: 40,
    alignItems: 'center',
  },
  emptyText: {
    fontSize: 15,
  },
  errorText: {
    color: '#EF4444',
    fontSize: 15,
    textAlign: 'center',
    paddingHorizontal: 32,
  },
  retryButton: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    backgroundColor: '#10B981',
    borderRadius: 8,
  },
  retryButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
});
