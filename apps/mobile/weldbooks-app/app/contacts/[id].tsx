import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  SafeAreaView,
  ScrollView,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { ChevronLeft } from 'lucide-react-native';

const TYPE_COLORS: Record<string, { bg: string; text: string }> = {
  customer: { bg: 'rgba(59,130,246,0.12)', text: '#3B82F6' },
  vendor: { bg: 'rgba(245,158,11,0.12)', text: '#F59E0B' },
};

export default function ContactDetailScreen() {
  const router = useRouter();
  const { id, name, email, type } = useLocalSearchParams<{
    id: string;
    name?: string;
    email?: string;
    type?: string;
  }>();
  const { colors } = useTheme();

  const contactName = name || 'Contact';
  const contactEmail = email || '';
  const contactType = (type as 'customer' | 'vendor') || 'customer';
  const typeStyle = TYPE_COLORS[contactType] || TYPE_COLORS.customer;

  const initials = contactName
    .split(' ')
    .map((n) => n[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <ChevronLeft size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Contact</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {/* Profile section */}
        <View style={styles.profileSection}>
          <View style={styles.avatarLarge}>
            <Text style={styles.avatarLargeText}>{initials}</Text>
          </View>
          <Text style={[styles.profileName, { color: colors.text }]}>{contactName}</Text>
          <View style={[styles.typeBadge, { backgroundColor: typeStyle.bg }]}>
            <Text style={[styles.typeText, { color: typeStyle.text }]}>
              {contactType.charAt(0).toUpperCase() + contactType.slice(1)}
            </Text>
          </View>
        </View>

        {/* Details card */}
        <View style={[styles.detailCard, { backgroundColor: colors.cardBackground }]}>
          <View style={styles.detailRow}>
            <Text style={[styles.detailLabel, { color: colors.muted }]}>Name</Text>
            <Text style={[styles.detailValue, { color: colors.text }]}>{contactName}</Text>
          </View>
          <View style={[styles.detailDivider, { backgroundColor: colors.divider }]} />
          <View style={styles.detailRow}>
            <Text style={[styles.detailLabel, { color: colors.muted }]}>Email</Text>
            <Text style={[styles.detailValue, { color: colors.text }]}>
              {contactEmail || 'Not provided'}
            </Text>
          </View>
          <View style={[styles.detailDivider, { backgroundColor: colors.divider }]} />
          <View style={styles.detailRow}>
            <Text style={[styles.detailLabel, { color: colors.muted }]}>Type</Text>
            <Text style={[styles.detailValue, { color: colors.text }]}>
              {contactType.charAt(0).toUpperCase() + contactType.slice(1)}
            </Text>
          </View>
          <View style={[styles.detailDivider, { backgroundColor: colors.divider }]} />
          <View style={styles.detailRow}>
            <Text style={[styles.detailLabel, { color: colors.muted }]}>ID</Text>
            <Text style={[styles.detailValue, { color: colors.muted }]}>{id}</Text>
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
  profileSection: {
    alignItems: 'center',
    paddingVertical: 24,
    gap: 10,
  },
  avatarLarge: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: '#10B981',
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarLargeText: {
    color: '#fff',
    fontSize: 24,
    fontWeight: '700',
  },
  profileName: {
    fontSize: 22,
    fontWeight: '700',
  },
  typeBadge: {
    paddingHorizontal: 14,
    paddingVertical: 5,
    borderRadius: 8,
  },
  typeText: {
    fontSize: 13,
    fontWeight: '600',
  },
  detailCard: {
    borderRadius: 12,
    padding: 16,
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
  },
  detailLabel: {
    fontSize: 14,
  },
  detailValue: {
    fontSize: 15,
    fontWeight: '500',
    maxWidth: '60%',
    textAlign: 'right',
  },
  detailDivider: {
    height: StyleSheet.hairlineWidth,
  },
});
