import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  SafeAreaView,
  ScrollView,
  Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import api from '@/services/api';
import { formatCurrency } from '@/lib/currency';
import { ChevronLeft } from 'lucide-react-native';

type ProfitLossData = {
  revenue: number;
  expenses: number;
  netProfit: number;
  profitMargin: number;
  currency: string;
};

function getDefaultDateRange() {
  const now = new Date();
  const year = now.getFullYear();
  const fromDate = `${year}-01-01`;
  const toDate = now.toISOString().split('T')[0];
  return { fromDate, toDate };
}

function formatDateLabel(dateStr: string): string {
  const date = new Date(dateStr + 'T00:00:00');
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function ProfitLossScreen() {
  const router = useRouter();
  const { colors } = useTheme();

  const defaults = getDefaultDateRange();
  const [fromDate, setFromDate] = useState(defaults.fromDate);
  const [toDate, setToDate] = useState(defaults.toDate);
  const [data, setData] = useState<ProfitLossData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      setError(null);
      setLoading(true);
      const result = await api.getProfitLoss(fromDate, toDate);
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load report');
    } finally {
      setLoading(false);
    }
  }, [fromDate, toDate]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleQuickRange = (months: number) => {
    const now = new Date();
    const from = new Date(now);
    from.setMonth(from.getMonth() - months);
    setFromDate(from.toISOString().split('T')[0]);
    setToDate(now.toISOString().split('T')[0]);
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <ChevronLeft size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Profit & Loss</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {/* Date range */}
        <View style={[styles.dateCard, { backgroundColor: colors.cardBackground }]}>
          <View style={styles.dateRow}>
            <View style={styles.dateField}>
              <Text style={[styles.dateLabel, { color: colors.muted }]}>From</Text>
              <Text style={[styles.dateValue, { color: colors.text }]}>
                {formatDateLabel(fromDate)}
              </Text>
            </View>
            <View style={[styles.dateSeparator, { backgroundColor: colors.divider }]} />
            <View style={styles.dateField}>
              <Text style={[styles.dateLabel, { color: colors.muted }]}>To</Text>
              <Text style={[styles.dateValue, { color: colors.text }]}>
                {formatDateLabel(toDate)}
              </Text>
            </View>
          </View>
          <View style={styles.quickRangeRow}>
            {[
              { label: '1M', months: 1 },
              { label: '3M', months: 3 },
              { label: '6M', months: 6 },
              { label: 'YTD', months: new Date().getMonth() },
              { label: '1Y', months: 12 },
            ].map((range) => (
              <TouchableOpacity
                key={range.label}
                style={[styles.quickRangeButton, { borderColor: colors.divider }]}
                onPress={() => handleQuickRange(range.months)}
              >
                <Text style={[styles.quickRangeText, { color: colors.text }]}>
                  {range.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {loading ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color="#10B981" />
          </View>
        ) : error ? (
          <View style={styles.errorContainer}>
            <Text style={styles.errorText}>{error}</Text>
            <TouchableOpacity style={styles.retryButton} onPress={fetchData}>
              <Text style={styles.retryButtonText}>Retry</Text>
            </TouchableOpacity>
          </View>
        ) : data ? (
          <>
            {/* Summary cards */}
            <View style={styles.summaryGrid}>
              <View style={[styles.summaryCard, { backgroundColor: colors.cardBackground }]}>
                <Text style={[styles.summaryLabel, { color: colors.muted }]}>Revenue</Text>
                <Text style={[styles.summaryValue, { color: '#10B981' }]}>
                  {formatCurrency(data.revenue, data.currency)}
                </Text>
              </View>
              <View style={[styles.summaryCard, { backgroundColor: colors.cardBackground }]}>
                <Text style={[styles.summaryLabel, { color: colors.muted }]}>Expenses</Text>
                <Text style={[styles.summaryValue, { color: '#EF4444' }]}>
                  {formatCurrency(data.expenses, data.currency)}
                </Text>
              </View>
            </View>

            {/* Net profit card */}
            <View style={[styles.netProfitCard, { backgroundColor: colors.cardBackground }]}>
              <Text style={[styles.netProfitLabel, { color: colors.muted }]}>Net Profit</Text>
              <Text
                style={[
                  styles.netProfitValue,
                  { color: data.netProfit >= 0 ? '#10B981' : '#EF4444' },
                ]}
              >
                {formatCurrency(data.netProfit, data.currency)}
              </Text>
              <View style={styles.marginRow}>
                <Text style={[styles.marginLabel, { color: colors.muted }]}>Profit Margin</Text>
                <Text
                  style={[
                    styles.marginValue,
                    { color: data.profitMargin >= 0 ? '#10B981' : '#EF4444' },
                  ]}
                >
                  {data.profitMargin.toFixed(1)}%
                </Text>
              </View>
            </View>
          </>
        ) : null}
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
  content: {
    paddingHorizontal: 16,
    paddingBottom: 32,
  },
  dateCard: {
    borderRadius: 12,
    padding: 16,
    marginBottom: 20,
  },
  dateRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  dateField: {
    flex: 1,
    alignItems: 'center',
  },
  dateLabel: {
    fontSize: 12,
    marginBottom: 4,
  },
  dateValue: {
    fontSize: 15,
    fontWeight: '600',
  },
  dateSeparator: {
    width: 1,
    height: 32,
  },
  quickRangeRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 8,
    marginTop: 14,
  },
  quickRangeButton: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
  },
  quickRangeText: {
    fontSize: 13,
    fontWeight: '600',
  },
  loadingContainer: {
    paddingVertical: 60,
    alignItems: 'center',
  },
  errorContainer: {
    paddingVertical: 40,
    alignItems: 'center',
    gap: 12,
  },
  errorText: {
    color: '#EF4444',
    fontSize: 15,
    textAlign: 'center',
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
  summaryGrid: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 12,
  },
  summaryCard: {
    flex: 1,
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
  },
  summaryLabel: {
    fontSize: 13,
    marginBottom: 6,
  },
  summaryValue: {
    fontSize: 20,
    fontWeight: '700',
  },
  netProfitCard: {
    borderRadius: 12,
    padding: 20,
    alignItems: 'center',
  },
  netProfitLabel: {
    fontSize: 14,
    marginBottom: 4,
  },
  netProfitValue: {
    fontSize: 28,
    fontWeight: '700',
  },
  marginRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 12,
  },
  marginLabel: {
    fontSize: 13,
  },
  marginValue: {
    fontSize: 16,
    fontWeight: '700',
  },
});
