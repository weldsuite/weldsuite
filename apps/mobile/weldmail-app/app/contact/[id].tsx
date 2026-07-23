import { styles } from './[id].styles';
import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Linking,
  Keyboard,
} from 'react-native';
import MaterialSpinner from '@/components/MaterialSpinner';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, router } from 'expo-router';
import {
  X,
  Mail,
  Phone,
  User,
  ChevronDown,
  ChevronRight,
  EllipsisVertical,
  FileText,
  MessageSquare,
  List,
  Globe,
  Type,
  Users,
  Tag,
  MapPin,
} from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { appApiClient } from '@/services/app-api';

interface Contact {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  fullName?: string;
  directPhone?: string;
  mobilePhone?: string;
  department?: string;
  notes?: string;
  status?: string;
  linkedinUrl?: string;
  twitterHandle?: string;
  interests?: string[];
  lastContactedAt?: string;
  bestTimeToContact?: string;
}

function getContactName(c: Contact) {
  if (c.fullName) return c.fullName;
  return `${c.firstName || ''} ${c.lastName || ''}`.trim() || 'Unknown';
}

function getFieldValue(contact: Contact, key: string): string | null {
  const c = contact as any;
  switch (key) {
    case 'domains': return c._domains || c.linkedinUrl || null;
    case 'name':
      if (contact.fullName) return contact.fullName;
      return `${contact.firstName || ''} ${contact.lastName || ''}`.trim() || null;
    case 'description': return c._description || c.description || contact.notes || null;
    case 'team': return c._team || c.department || null;
    case 'email': return contact.email || null;
    case 'phone': return contact.directPhone || contact.mobilePhone || null;
    case 'categories': {
      if (c._categories?.length > 0) return c._categories.join(', ');
      if (Array.isArray(c.interests) && c.interests.length > 0) return c.interests.join(', ');
      return null;
    }
    case 'industry': return c._industry || c.twitterHandle || null;
    case 'address': return c.bestTimeToContact || null;
    default: return null;
  }
}

type SidebarTab = 'details' | 'comments';

export default function ContactDetailScreen() {
  const { id } = useLocalSearchParams();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [contact, setContact] = useState<Contact | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<SidebarTab>('details');
  const [recordDetailsExpanded, setRecordDetailsExpanded] = useState(true);
  const [editingField, setEditingField] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<TextInput>(null);

  useEffect(() => { loadContact(); }, [id]);

  const loadContact = async () => {
    try {
      setLoading(true);
      const idStr = id as string;
      if (idStr.includes('@')) {
        try {
          const { data: searchData } = await appApiClient.get<{ data: Contact[] }>(`/people?search=${encodeURIComponent(idStr)}&limit=1`);
          const items: Contact[] = (searchData as any)?.data ?? (Array.isArray(searchData) ? searchData : []);
          if (items.length > 0) { setContact(items[0]); return; }
        } catch {}
        setContact({ id: idStr, email: idStr, firstName: idStr.split('@')[0], lastName: '', status: 'active' } as Contact);
        return;
      }
      const { data: contactData } = await appApiClient.get<{ data: Contact }>('/people/' + idStr);
      const contact: Contact = (contactData as any)?.data ?? contactData;
      if (contact) setContact(contact);
    } catch {} finally { setLoading(false); }
  };

  // Contact fields can originate from a spoofed email sender, so sanitise before
  // building tel:/mailto: URLs (strip CRLF / mailto-header-injection characters).
  const handleCall = (phone: string) => {
    const clean = phone.replace(/[^0-9+]/g, '');
    if (clean) Linking.openURL(`tel:${clean}`);
  };
  const handleEmail = (email: string) => {
    const clean = email.trim();
    if (/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(clean)) {
      Linking.openURL(`mailto:${clean}`);
    }
  };

  const startEditing = useCallback((fieldKey: string, currentValue: string) => {
    setEditingField(fieldKey);
    setEditValue(currentValue);
    setTimeout(() => inputRef.current?.focus(), 50);
  }, []);

  const saveField = useCallback(async () => {
    if (!contact || !editingField || saving) return;
    const trimmed = editValue.trim();
    const originalValue = getFieldValue(contact, editingField);
    if (trimmed === (originalValue || '')) { setEditingField(null); setEditValue(''); Keyboard.dismiss(); return; }

    setSaving(true);
    try {
      const updateData: Record<string, any> = {};
      if (editingField === 'name') {
        const parts = trimmed.split(' ');
        updateData.firstName = parts[0] || '';
        updateData.lastName = parts.slice(1).join(' ') || '';
      } else if (editingField === 'email') { updateData.email = trimmed; }
      else if (editingField === 'phone') { updateData.directPhone = trimmed; }
      else if (editingField === 'description') { updateData.notes = trimmed; }
      else if (editingField === 'team') { updateData.department = trimmed; }
      else if (editingField === 'domains') { updateData.linkedinUrl = trimmed; }

      const { data: updatedData } = await appApiClient.patch<{ data: Contact }>('/people/' + contact.id, updateData);
      const updated: Contact = (updatedData as any)?.data ?? updatedData;
      if (updated) setContact(updated);
    } catch {} finally {
      setSaving(false);
      setEditingField(null);
      setEditValue('');
    }
  }, [contact, editingField, editValue, saving]);

  // The loading and not-found states share the same header + container shell;
  // only the centered content differs.
  const renderContactShell = (children: React.ReactNode) => (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: insets.top + 8, borderBottomColor: colors.border || colors.divider }]}>
        <View style={styles.headerCenter}>
          <Text style={[styles.headerName, { color: colors.text }]}>Contact</Text>
        </View>
        <View style={styles.headerRight}>
          <TouchableOpacity style={styles.headerIconButton} onPress={() => router.back()}>
            <X size={18} color={colors.muted} strokeWidth={2} />
          </TouchableOpacity>
        </View>
      </View>
      <View style={styles.centerContainer}>{children}</View>
    </View>
  );

  if (loading) {
    return renderContactShell(
      <MaterialSpinner size={32} strokeWidth={3} color={colors.text} spinning />,
    );
  }

  if (!contact) {
    return renderContactShell(
      <Text style={[styles.emptyText, { color: colors.muted }]}>Contact not found</Text>,
    );
  }

  const name = getContactName(contact);

  const detailFields: { key: string; icon: any; label: string; editable?: boolean; isLink?: boolean; linkAction?: () => void; placeholder?: string; keyboardType?: 'default' | 'email-address' | 'phone-pad'; multiline?: boolean }[] = [
    { key: 'domains', icon: Globe, label: 'Domains', editable: true, placeholder: 'Set Domains...' },
    { key: 'name', icon: Type, label: 'Name', editable: true, placeholder: 'Set Name...' },
    { key: 'description', icon: FileText, label: 'Description', editable: true, placeholder: 'Set Description...', multiline: true },
    { key: 'team', icon: Users, label: 'Team', editable: true, placeholder: 'Set a value...' },
    { key: 'email', icon: Mail, label: 'Email', editable: true, isLink: true, linkAction: contact.email ? () => handleEmail(contact.email) : undefined, placeholder: 'Set Email...', keyboardType: 'email-address' },
    { key: 'phone', icon: Phone, label: 'Phone', editable: true, isLink: true, linkAction: (contact.directPhone || contact.mobilePhone) ? () => handleCall((contact.directPhone || contact.mobilePhone)!) : undefined, placeholder: 'Set Phone...', keyboardType: 'phone-pad' },
    { key: 'address', icon: MapPin, label: 'Address', editable: false, placeholder: 'Set Address...' },
  ];

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header: Avatar + Name | Mail Phone ⋮ X */}
      <View style={[styles.header, { paddingTop: insets.top + 8, borderBottomColor: colors.border || colors.divider }]}>
        <View style={styles.headerCenter}>
          <View style={styles.headerAvatar}>
            <User size={14} color="#10B981" strokeWidth={2} />
          </View>
          <Text style={[styles.headerName, { color: colors.text }]} numberOfLines={1}>
            {name}
          </Text>
        </View>
        <View style={styles.headerRight}>
          <TouchableOpacity
            style={styles.headerIconButton}
            onPress={contact.email ? () => handleEmail(contact.email) : undefined}
            disabled={!contact.email}
          >
            <Mail size={16} color={contact.email ? '#6B7280' : '#E5E7EB'} strokeWidth={2} />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.headerIconButton}
            onPress={(contact.directPhone || contact.mobilePhone) ? () => handleCall((contact.directPhone || contact.mobilePhone)!) : undefined}
            disabled={!contact.directPhone && !contact.mobilePhone}
          >
            <Phone size={16} color={(contact.directPhone || contact.mobilePhone) ? '#6B7280' : '#E5E7EB'} strokeWidth={2} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.headerIconButton}>
            <EllipsisVertical size={16} color="#6B7280" strokeWidth={2} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.headerIconButton} onPress={() => router.back()}>
            <X size={18} color={colors.muted} strokeWidth={2} />
          </TouchableOpacity>
        </View>
      </View>

      {/* Tabs: Details | Comments */}
      <View style={[styles.tabBar, { borderBottomColor: colors.border || colors.divider }]}>
        <TouchableOpacity style={styles.tab} onPress={() => setActiveTab('details')}>
          <View style={[styles.tabInner, activeTab === 'details' && styles.tabInnerActive]}>
            <List size={14} color={activeTab === 'details' ? colors.text : colors.muted} strokeWidth={2} />
            <Text style={[styles.tabText, { color: activeTab === 'details' ? colors.text : colors.muted }, activeTab === 'details' && styles.tabTextActive]}>
              Details
            </Text>
          </View>
        </TouchableOpacity>
        <TouchableOpacity style={styles.tab} onPress={() => setActiveTab('comments')}>
          <View style={[styles.tabInner, activeTab === 'comments' && styles.tabInnerActive]}>
            <MessageSquare size={14} color={activeTab === 'comments' ? colors.text : colors.muted} strokeWidth={2} />
            <Text style={[styles.tabText, { color: activeTab === 'comments' ? colors.text : colors.muted }, activeTab === 'comments' && styles.tabTextActive]}>
              Comments
            </Text>
          </View>
        </TouchableOpacity>
      </View>

      {activeTab === 'details' ? (
        <ScrollView style={styles.content} showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
          {/* Record Details Section */}
          <View style={styles.sectionWrapper}>
            <TouchableOpacity style={styles.sectionHeader} onPress={() => setRecordDetailsExpanded(!recordDetailsExpanded)} activeOpacity={0.7}>
              {recordDetailsExpanded ? <ChevronDown size={16} color={colors.muted} strokeWidth={2} /> : <ChevronRight size={16} color={colors.muted} strokeWidth={2} />}
              <Text style={[styles.sectionTitle, { color: colors.text }]}>Record Details</Text>
            </TouchableOpacity>

            {recordDetailsExpanded && (
              <View style={styles.fieldsContainer}>
                {detailFields.map((field) => {
                  const IconComponent = field.icon;
                  const value = getFieldValue(contact, field.key);
                  const hasValue = !!value;
                  const isEditing = editingField === field.key;

                  return (
                    <View key={field.key} style={styles.fieldRow}>
                      <View style={styles.fieldLabel}>
                        <IconComponent size={16} color={colors.muted} strokeWidth={2} />
                        <Text style={[styles.fieldLabelText, { color: colors.muted }]}>{field.label}</Text>
                      </View>
                      <View style={styles.fieldValue}>
                        {isEditing ? (
                          <TextInput
                            ref={inputRef}
                            style={[styles.fieldInput, { color: colors.text, borderColor: '#3B82F6', backgroundColor: colors.background }]}
                            value={editValue}
                            onChangeText={setEditValue}
                            onBlur={saveField}
                            onSubmitEditing={saveField}
                            placeholder={field.placeholder}
                            placeholderTextColor={colors.muted}
                            keyboardType={field.keyboardType || 'default'}
                            autoCapitalize={field.keyboardType === 'email-address' ? 'none' : 'sentences'}
                            returnKeyType="done"
                            autoFocus
                          />
                        ) : (
                          <TouchableOpacity
                            onPress={() => {
                              if (field.isLink && hasValue && field.linkAction) field.linkAction();
                              else if (field.editable) startEditing(field.key, value || '');
                            }}
                            disabled={!field.editable && !(field.isLink && hasValue)}
                            activeOpacity={0.6}
                            style={styles.fieldValueTouchable}
                          >
                            <Text
                              style={[
                                styles.fieldValueText,
                                { color: hasValue ? (field.isLink ? '#2563EB' : colors.text) : colors.muted },
                                field.isLink && hasValue && styles.fieldValueLink,
                              ]}
                              numberOfLines={field.multiline ? 3 : 1}
                            >
                              {hasValue ? value : `Set ${field.label}...`}
                            </Text>
                          </TouchableOpacity>
                        )}
                      </View>
                    </View>
                  );
                })}
              </View>
            )}
          </View>
        </ScrollView>
      ) : (
        <View style={styles.commentsContainer}>
          <View style={styles.commentsEmpty}>
            <MessageSquare size={24} color={colors.muted} strokeWidth={1.5} />
            <Text style={[styles.commentsEmptyTitle, { color: colors.muted }]}>No comments yet</Text>
            <Text style={[styles.commentsEmptySubtitle, { color: colors.muted }]}>Be the first to add a comment</Text>
          </View>
        </View>
      )}
    </View>
  );
}


