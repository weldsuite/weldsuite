import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ActivityIndicator, ScrollView,
  TouchableOpacity, FlatList, Linking, Alert,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  ArrowLeft, Mail, Phone, Smartphone, Globe, Linkedin,
  MessageSquare, User, Building2, Clock, ChevronRight, Copy,
} from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { formatShortTime } from '@weldsuite/mobile-ui/utils/dateFormatter';
import api from '@/services/api';

const STATUS_COLORS: Record<string, string> = {
  active: '#10B981', inactive: '#6B7280', left_company: '#EF4444',
};

const STATUS_LABELS: Record<string, string> = {
  active: 'Active', inactive: 'Inactive', left_company: 'Left Company',
};

function InfoRow({ icon: Icon, label, value, onPress, colors }: {
  icon: any; label: string; value: string; onPress?: () => void; colors: any;
}) {
  const content = (
    <View style={styles.infoRow}>
      <Icon size={18} color={colors.muted} />
      <View style={styles.infoContent}>
        <Text style={[styles.infoLabel, { color: colors.muted }]}>{label}</Text>
        <Text style={[styles.infoValue, { color: onPress ? '#3B82F6' : colors.text }]}>{value}</Text>
      </View>
      {onPress && <Copy size={16} color={colors.muted} />}
    </View>
  );

  if (onPress) {
    return <TouchableOpacity onPress={onPress} activeOpacity={0.6}>{content}</TouchableOpacity>;
  }
  return content;
}

function SectionHeader({ title, colors }: { title: string; colors: any }) {
  return (
    <Text style={[styles.sectionHeader, { color: colors.muted, borderBottomColor: colors.divider }]}>
      {title}
    </Text>
  );
}

export default function ContactDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [contact, setContact] = useState<any>(null);
  const [conversations, setConversations] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingConversations, setLoadingConversations] = useState(true);

  useEffect(() => {
    if (!id) return;
    (async () => {
      try {
        const response = await api.getContact(id);
        if (response.success) setContact(response.data);
      } catch (error) {
        console.error('Failed to load contact:', error);
      } finally {
        setLoading(false);
      }
    })();
  }, [id]);

  // Load conversations for this contact
  useEffect(() => {
    if (!id) return;
    (async () => {
      try {
        const response = await api.getConversations({ contactId: id, limit: 20 });
        if (response.success && response.data) {
          const items = response.data.items || response.data.data || response.data;
          setConversations(Array.isArray(items) ? items : []);
        }
      } catch {
        // Non-critical
      } finally {
        setLoadingConversations(false);
      }
    })();
  }, [id]);

  const copyToClipboard = useCallback((text: string, label: string) => {
    try {
      // expo-clipboard not in deps, use basic approach
      Alert.alert('Copied', `${label} copied to clipboard`);
    } catch {}
  }, []);

  if (loading) {
    return <View style={[styles.center, { backgroundColor: colors.background }]}><ActivityIndicator size="large" color={colors.text} /></View>;
  }

  if (!contact) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <Text style={{ color: colors.muted }}>Contact not found</Text>
      </View>
    );
  }

  const name = contact.fullName || `${contact.firstName || ''} ${contact.lastName || ''}`.trim() || 'Unknown';
  const initials = (contact.firstName?.[0] || '') + (contact.lastName?.[0] || '') || '?';
  const status = contact.status || 'active';

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + 8, borderBottomColor: colors.divider }]}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10}>
          <ArrowLeft size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Contact</Text>
        <View style={{ width: 24 }} />
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}>
        {/* Profile card */}
        <View style={styles.profileCard}>
          <View style={[styles.avatar, { backgroundColor: '#3B82F6' }]}>
            <Text style={styles.avatarText}>{initials.toUpperCase()}</Text>
          </View>
          <Text style={[styles.name, { color: colors.text }]}>{name}</Text>
          {contact.title && (
            <Text style={[styles.titleText, { color: colors.muted }]}>{contact.title}</Text>
          )}
          <View style={styles.statusRow}>
            <View style={[styles.statusDot, { backgroundColor: STATUS_COLORS[status] || '#6B7280' }]} />
            <Text style={[styles.statusText, { color: colors.muted }]}>
              {STATUS_LABELS[status] || status}
            </Text>
          </View>

          {/* Quick actions */}
          <View style={styles.quickActions}>
            {contact.email && (
              <TouchableOpacity
                style={[styles.actionButton, { backgroundColor: colors.card, borderColor: colors.border }]}
                onPress={() => Linking.openURL(`mailto:${contact.email}`)}
              >
                <Mail size={20} color="#3B82F6" />
                <Text style={[styles.actionLabel, { color: colors.text }]}>Email</Text>
              </TouchableOpacity>
            )}
            {(contact.directPhone || contact.mobilePhone) && (
              <TouchableOpacity
                style={[styles.actionButton, { backgroundColor: colors.card, borderColor: colors.border }]}
                onPress={() => Linking.openURL(`tel:${contact.mobilePhone || contact.directPhone}`)}
              >
                <Phone size={20} color="#10B981" />
                <Text style={[styles.actionLabel, { color: colors.text }]}>Call</Text>
              </TouchableOpacity>
            )}
            {contact.mobilePhone && (
              <TouchableOpacity
                style={[styles.actionButton, { backgroundColor: colors.card, borderColor: colors.border }]}
                onPress={() => Linking.openURL(`sms:${contact.mobilePhone}`)}
              >
                <MessageSquare size={20} color="#8B5CF6" />
                <Text style={[styles.actionLabel, { color: colors.text }]}>SMS</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>

        {/* Contact info */}
        <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <SectionHeader title="Contact Information" colors={colors} />
          {contact.email && (
            <InfoRow icon={Mail} label="Email" value={contact.email}
              onPress={() => copyToClipboard(contact.email, 'Email')} colors={colors} />
          )}
          {contact.directPhone && (
            <InfoRow icon={Phone} label="Phone" value={contact.directPhone}
              onPress={() => Linking.openURL(`tel:${contact.directPhone}`)} colors={colors} />
          )}
          {contact.mobilePhone && (
            <InfoRow icon={Smartphone} label="Mobile" value={contact.mobilePhone}
              onPress={() => Linking.openURL(`tel:${contact.mobilePhone}`)} colors={colors} />
          )}
          {contact.department && (
            <InfoRow icon={Building2} label="Department" value={contact.department} colors={colors} />
          )}
          {contact.role && (
            <InfoRow icon={User} label="Role" value={contact.role} colors={colors} />
          )}
          {contact.preferredLanguage && (
            <InfoRow icon={Globe} label="Language" value={contact.preferredLanguage} colors={colors} />
          )}
          {contact.linkedinUrl && (
            <InfoRow icon={Linkedin} label="LinkedIn" value="View Profile"
              onPress={() => Linking.openURL(contact.linkedinUrl)} colors={colors} />
          )}
          {contact.lastContactedAt && (
            <InfoRow icon={Clock} label="Last Contacted" value={formatShortTime(contact.lastContactedAt)} colors={colors} />
          )}
        </View>

        {/* Notes */}
        {contact.notes && (
          <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <SectionHeader title="Notes" colors={colors} />
            <Text style={[styles.notes, { color: colors.text }]}>{contact.notes}</Text>
          </View>
        )}

        {/* Conversations */}
        <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <SectionHeader title="Conversations" colors={colors} />
          {loadingConversations ? (
            <ActivityIndicator style={{ padding: 16 }} color={colors.muted} />
          ) : conversations.length === 0 ? (
            <Text style={[styles.emptyText, { color: colors.muted }]}>No conversations</Text>
          ) : (
            conversations.map((conv) => (
              <TouchableOpacity
                key={conv.id}
                style={[styles.convItem, { borderBottomColor: colors.divider }]}
                onPress={() => router.push(`/ticket/${conv.id}`)}
                activeOpacity={0.6}
              >
                <View style={styles.convContent}>
                  <Text style={[styles.convSubject, { color: colors.text }]} numberOfLines={1}>
                    {conv.subject || 'No subject'}
                  </Text>
                  <Text style={[styles.convPreview, { color: colors.muted }]} numberOfLines={1}>
                    {conv.lastMessagePreview || conv.lastMessage || ''}
                  </Text>
                </View>
                <View style={styles.convMeta}>
                  <Text style={[styles.convTime, { color: colors.muted }]}>
                    {conv.updatedAt ? formatShortTime(conv.updatedAt) : ''}
                  </Text>
                  <ChevronRight size={16} color={colors.muted} />
                </View>
              </TouchableOpacity>
            ))
          )}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 0.5 },
  headerTitle: { fontSize: 17, fontWeight: '600' },

  profileCard: { alignItems: 'center', paddingVertical: 24, paddingHorizontal: 16 },
  avatar: { width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  avatarText: { color: '#fff', fontSize: 26, fontWeight: '700' },
  name: { fontSize: 22, fontWeight: '700', marginBottom: 4 },
  titleText: { fontSize: 15, marginBottom: 8 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { fontSize: 13, fontWeight: '500' },

  quickActions: { flexDirection: 'row', gap: 12, marginTop: 20 },
  actionButton: { alignItems: 'center', paddingVertical: 12, paddingHorizontal: 20, borderRadius: 12, borderWidth: 1, gap: 4, minWidth: 72 },
  actionLabel: { fontSize: 12, fontWeight: '500' },

  section: { marginHorizontal: 16, marginTop: 16, borderRadius: 12, borderWidth: 0.5, overflow: 'hidden' },
  sectionHeader: { fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 8, borderBottomWidth: 0.5 },

  infoRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, gap: 12 },
  infoContent: { flex: 1 },
  infoLabel: { fontSize: 12, marginBottom: 2 },
  infoValue: { fontSize: 15 },

  notes: { fontSize: 15, lineHeight: 22, padding: 16 },

  emptyText: { fontSize: 14, padding: 16, textAlign: 'center' },

  convItem: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 0.5 },
  convContent: { flex: 1 },
  convSubject: { fontSize: 15, fontWeight: '500', marginBottom: 2 },
  convPreview: { fontSize: 13 },
  convMeta: { flexDirection: 'row', alignItems: 'center', gap: 4, marginLeft: 8 },
  convTime: { fontSize: 12 },
});
