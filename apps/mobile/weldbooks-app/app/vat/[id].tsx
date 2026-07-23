import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  SafeAreaView,
  ScrollView,
  Alert,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import api from '@/services/api';
import { formatCurrency } from '@/lib/currency';
import { ChevronLeft } from 'lucide-react-native';

type VatReturnDetail = {
  id: string;
  period: string;
  year: number;
  status: 'draft' | 'submitted' | 'accepted' | 'rejected';
  salesTax: number;
  purchaseTax: number;
  netAmount: number;
  currency: string;
};

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  draft: { bg: 'rgba(107,114,128,0.12)', text: '#6B7280' },
  submitted: { bg: 'rgba(59,130,246,0.12)', text: '#3B82F6' },
  accepted: { bg: 'rgba(16,185,129,0.12)', text: '#10B981' },
  rejected: { bg: 'rgba(239,68,68,0.12)', text: '#EF4444' },
};

export default function VatReturnDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useTheme();

  const [vatReturn, setVatReturn] = useState<VatReturnDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchReturn = useCallback(async () => {
    if (!id) return;
    try {
      setError(null);
      const data = await api.getVatReturn(id);
      setVatReturn(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load VAT return');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchReturn();
  }, [fetchReturn]);

  const handleSubmit = async () => {
    if (!id || !vatReturn) return;

    Alert.alert(
      'Submit VAT Return',
      `Are you sure you want to submit the VAT return for ${vatReturn.period} ${vatReturn.year}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Submit',
          style: 'default',
          onPress: async () => {
            setSubmitting(true);
            try {
              await api.submitVatReturn(id);
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              setVatReturn((prev) => (prev ? { ...prev, status: 'submitted' } : null));
            } catch (err) {
              Alert.alert('Error', 'Failed to submit VAT return. Please try again.');
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
            } finally {
              setSubmitting(false);
            }
          },
        },
      ],
    );
  };

  if (loading) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
        <View style={styles.centered}>
          <ActivityIndicator size="large" color="#10B981" />
        </View>
      </SafeAreaView>
    );
  }

  if (error || !vatReturn) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
            <ChevronLeft size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={[styles.headerTitle, { color: colors.text }]}>VAT Return</Text>
          <View style={styles.headerSpacer} />
        </View>
        <View style={styles.centered}>
          <Text style={styles.errorText}>{error || 'VAT return not found'}</Text>
          <TouchableOpacity style={styles.retryButton} onPress={fetchReturn}>
            <Text style={styles.retryButtonText}>Retry</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  const statusStyle = STATUS_COLORS[vatReturn.status] || STATUS_COLORS.draft;

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <ChevronLeft size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>
          {vatReturn.period} {vatReturn.year}
        </Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {/* Status & Period */}
        <View style={[styles.infoCard, { backgroundColor: colors.cardBackground }]}>
          <View style={styles.infoRow}>
            <Text style={[styles.infoLabel, { color: colors.muted }]}>Status</Text>
            <View style={[styles.statusBadge, { backgroundColor: statusStyle.bg }]}>
              <Text style={[styles.statusText, { color: statusStyle.text }]}>
                {vatReturn.status.charAt(0).toUpperCase() + vatReturn.status.slice(1)}
              </Text>
            </View>
          </View>
          <View style={[styles.infoDivider, { backgroundColor: colors.divider }]} />
          <View style={styles.infoRow}>
            <Text style={[styles.infoLabel, { color: colors.muted }]}>Period</Text>
            <Text style={[styles.infoValue, { color: colors.text }]}>{vatReturn.period}</Text>
          </View>
          <View style={[styles.infoDivider, { backgroundColor: colors.divider }]} />
          <View style={styles.infoRow}>
            <Text style={[styles.infoLabel, { color: colors.muted }]}>Year</Text>
            <Text style={[styles.infoValue, { color: colors.text }]}>{vatReturn.year}</Text>
          </View>
        </View>

        {/* Tax Breakdown */}
        <Text style={[styles.sectionTitle, { color: colors.muted }]}>TAX BREAKDOWN</Text>
        <View style={[styles.breakdownCard, { backgroundColor: colors.cardBackground }]}>
          <View style={styles.breakdownRow}>
            <Text style={[styles.breakdownLabel, { color: colors.text }]}>Sales Tax</Text>
            <Text style={[styles.breakdownValue, { color: '#EF4444' }]}>
              {formatCurrency(vatReturn.salesTax, vatReturn.currency)}
            </Text>
          </View>
          <View style={[styles.infoDivider, { backgroundColor: colors.divider }]} />
          <View style={styles.breakdownRow}>
            <Text style={[styles.breakdownLabel, { color: colors.text }]}>Purchase Tax</Text>
            <Text style={[styles.breakdownValue, { color: '#10B981' }]}>
              {formatCurrency(vatReturn.purchaseTax, vatReturn.currency)}
            </Text>
          </View>
          <View style={[styles.infoDivider, { backgroundColor: colors.divider }]} />
          <View style={styles.breakdownRow}>
            <Text style={[styles.breakdownLabel, { color: colors.text, fontWeight: '700' }]}>
              Net Amount
            </Text>
            <Text
              style={[
                styles.breakdownValue,
                {
                  color: vatReturn.netAmount >= 0 ? '#EF4444' : '#10B981',
                  fontWeight: '700',
                  fontSize: 18,
                },
              ]}
            >
              {formatCurrency(vatReturn.netAmount, vatReturn.currency)}
            </Text>
          </View>
        </View>

        {/* Submit button */}
        {vatReturn.status === 'draft' && (
          <TouchableOpacity
            style={[styles.submitButton, submitting && styles.submitButtonDisabled]}
            onPress={handleSubmit}
            disabled={submitting}
          >
            {submitting ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Text style={styles.submitButtonText}>Submit VAT Return</Text>
            )}
          </TouchableOpacity>
        )}
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
  },
  infoCard: {
    borderRadius: 12,
    padding: 16,
    marginBottom: 24,
  },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
  },
  infoLabel: {
    fontSize: 14,
  },
  infoValue: {
    fontSize: 15,
    fontWeight: '500',
  },
  infoDivider: {
    height: StyleSheet.hairlineWidth,
  },
  statusBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
  },
  statusText: {
    fontSize: 13,
    fontWeight: '600',
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.8,
    marginBottom: 8,
    marginLeft: 4,
  },
  breakdownCard: {
    borderRadius: 12,
    padding: 16,
    marginBottom: 24,
  },
  breakdownRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
  },
  breakdownLabel: {
    fontSize: 15,
  },
  breakdownValue: {
    fontSize: 16,
    fontWeight: '600',
  },
  submitButton: {
    backgroundColor: '#10B981',
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 8,
  },
  submitButtonDisabled: {
    opacity: 0.7,
  },
  submitButtonText: {
    color: '#fff',
    fontSize: 16,
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
