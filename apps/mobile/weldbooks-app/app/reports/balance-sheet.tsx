import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  SafeAreaView,
  ScrollView,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import api from '@/services/api';
import { formatCurrency } from '@/lib/currency';
import { ChevronLeft } from 'lucide-react-native';

type AccountLine = {
  code: string;
  name: string;
  balance: number;
};

type BalanceSheetSection = {
  label: string;
  accounts: AccountLine[];
  total: number;
};

type BalanceSheetData = {
  assets: BalanceSheetSection;
  liabilities: BalanceSheetSection;
  equity: BalanceSheetSection;
  currency: string;
};

export default function BalanceSheetScreen() {
  const router = useRouter();
  const { colors } = useTheme();

  const [data, setData] = useState<BalanceSheetData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      setError(null);
      const result = await api.getBalanceSheet();
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load balance sheet');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const renderSection = (section: BalanceSheetSection, currency: string) => (
    <View style={[styles.sectionCard, { backgroundColor: colors.cardBackground }]}>
      <Text style={[styles.sectionTitle, { color: colors.text }]}>{section.label}</Text>
      {section.accounts.map((account, index) => (
        <React.Fragment key={account.code}>
          {index > 0 && (
            <View style={[styles.accountDivider, { backgroundColor: colors.divider }]} />
          )}
          <View style={styles.accountRow}>
            <View style={styles.accountInfo}>
              <Text style={[styles.accountCode, { color: colors.muted }]}>{account.code}</Text>
              <Text style={[styles.accountName, { color: colors.text }]}>{account.name}</Text>
            </View>
            <Text style={[styles.accountBalance, { color: colors.text }]}>
              {formatCurrency(account.balance, currency)}
            </Text>
          </View>
        </React.Fragment>
      ))}
      <View style={[styles.totalDivider, { backgroundColor: colors.divider }]} />
      <View style={styles.totalRow}>
        <Text style={[styles.totalLabel, { color: colors.text }]}>Total {section.label}</Text>
        <Text style={[styles.totalValue, { color: colors.text }]}>
          {formatCurrency(section.total, currency)}
        </Text>
      </View>
    </View>
  );

  if (loading) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
            <ChevronLeft size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={[styles.headerTitle, { color: colors.text }]}>Balance Sheet</Text>
          <View style={styles.headerSpacer} />
        </View>
        <View style={styles.centered}>
          <ActivityIndicator size="large" color="#10B981" />
        </View>
      </SafeAreaView>
    );
  }

  if (error || !data) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
            <ChevronLeft size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={[styles.headerTitle, { color: colors.text }]}>Balance Sheet</Text>
          <View style={styles.headerSpacer} />
        </View>
        <View style={styles.centered}>
          <Text style={styles.errorText}>{error || 'Failed to load data'}</Text>
          <TouchableOpacity style={styles.retryButton} onPress={fetchData}>
            <Text style={styles.retryButtonText}>Retry</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  const totalLiabilitiesEquity = data.liabilities.total + data.equity.total;
  const isBalanced = Math.abs(data.assets.total - totalLiabilitiesEquity) < 0.01;

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <ChevronLeft size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Balance Sheet</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {renderSection(data.assets, data.currency)}
        {renderSection(data.liabilities, data.currency)}
        {renderSection(data.equity, data.currency)}

        {/* Comparison */}
        <View style={[styles.comparisonCard, { backgroundColor: colors.cardBackground }]}>
          <View style={styles.comparisonRow}>
            <Text style={[styles.comparisonLabel, { color: colors.text }]}>Total Assets</Text>
            <Text style={[styles.comparisonValue, { color: colors.text }]}>
              {formatCurrency(data.assets.total, data.currency)}
            </Text>
          </View>
          <View style={[styles.accountDivider, { backgroundColor: colors.divider }]} />
          <View style={styles.comparisonRow}>
            <Text style={[styles.comparisonLabel, { color: colors.text }]}>
              Total Liabilities + Equity
            </Text>
            <Text style={[styles.comparisonValue, { color: colors.text }]}>
              {formatCurrency(totalLiabilitiesEquity, data.currency)}
            </Text>
          </View>
          <View style={[styles.accountDivider, { backgroundColor: colors.divider }]} />
          <View style={styles.comparisonRow}>
            <Text style={[styles.comparisonLabel, { color: colors.muted }]}>Status</Text>
            <View
              style={[
                styles.balanceBadge,
                {
                  backgroundColor: isBalanced
                    ? 'rgba(16,185,129,0.12)'
                    : 'rgba(239,68,68,0.12)',
                },
              ]}
            >
              <Text
                style={[
                  styles.balanceBadgeText,
                  { color: isBalanced ? '#10B981' : '#EF4444' },
                ]}
              >
                {isBalanced ? 'Balanced' : 'Unbalanced'}
              </Text>
            </View>
          </View>
        </View>
      </ScrollView>
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
  content: {
    paddingHorizontal: 16,
    paddingBottom: 32,
    gap: 16,
  },
  sectionCard: {
    borderRadius: 12,
    padding: 16,
  },
  sectionTitle: {
    fontSize: 17,
    fontWeight: '700',
    marginBottom: 12,
  },
  accountRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
  },
  accountInfo: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginRight: 12,
  },
  accountCode: {
    fontSize: 12,
    fontFamily: 'monospace',
    minWidth: 40,
  },
  accountName: {
    fontSize: 14,
    flex: 1,
  },
  accountBalance: {
    fontSize: 14,
    fontWeight: '600',
  },
  accountDivider: {
    height: StyleSheet.hairlineWidth,
  },
  totalDivider: {
    height: 1,
    marginTop: 4,
  },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: 12,
  },
  totalLabel: {
    fontSize: 15,
    fontWeight: '700',
  },
  totalValue: {
    fontSize: 16,
    fontWeight: '700',
  },
  comparisonCard: {
    borderRadius: 12,
    padding: 16,
  },
  comparisonRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
  },
  comparisonLabel: {
    fontSize: 14,
    fontWeight: '500',
    flex: 1,
  },
  comparisonValue: {
    fontSize: 15,
    fontWeight: '700',
  },
  balanceBadge: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 6,
  },
  balanceBadgeText: {
    fontSize: 13,
    fontWeight: '600',
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
