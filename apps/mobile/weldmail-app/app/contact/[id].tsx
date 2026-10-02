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
  Alert,
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
  MapPin,
  type LucideIcon,
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

type ThemeColors = ReturnType<typeof useTheme>['colors'];

interface DetailField {
  key: string;
  icon: LucideIcon;
  label: string;
  editable?: boolean;
  isLink?: boolean;
  linkAction?: () => void;
  placeholder?: string;
  keyboardType?: 'default' | 'email-address' | 'phone-pad';
  multiline?: boolean;
}

/** API payloads are either `{ data: T }` or the bare record. */
function unwrapContact(payload: unknown): Contact | null {
  const wrapped = payload as { data?: Contact } | null | undefined;
  return wrapped?.data ?? (payload as Contact | null);
}

/**
 * The search is a substring match over names and emails, so the first hit for
 * bob@acme.com can be jimbob@acme.com.au. Only an exact email match is this
 * sender (edits PATCH whatever record is shown).
 */
async function findContactByEmail(email: string): Promise<Contact | null> {
  try {
    const { data: searchData } = await appApiClient.get<{ data: Contact[] }>(`/people?search=${encodeURIComponent(email)}&limit=20`);
    const wrapped = searchData as { data?: Contact[] } | Contact[] | null | undefined;
    let items: Contact[] = [];
    if (Array.isArray(wrapped)) items = wrapped;
    else if (wrapped?.data) items = wrapped.data;
    const wanted = email.trim().toLowerCase();
    return items.find((p) => (p.email || '').trim().toLowerCase() === wanted) ?? null;
  } catch {
    return null;
  }
}

async function fetchContact(idStr: string): Promise<Contact | null> {
  if (idStr.includes('@')) {
    const match = await findContactByEmail(idStr);
    return match ?? ({ id: idStr, email: idStr, firstName: idStr.split('@')[0], lastName: '', status: 'active' } as Contact);
  }
  const { data: contactData } = await appApiClient.get<{ data: Contact }>('/people/' + idStr);
  return unwrapContact(contactData);
}

// Contact fields can originate from a spoofed email sender, so sanitise before
// building tel:/mailto: URLs (strip CRLF / mailto-header-injection characters).
function callPhone(phone: string) {
  const clean = phone.replace(/[^0-9+]/g, '');
  if (clean) Linking.openURL(`tel:${clean}`);
}

function emailContact(email: string) {
  const clean = email.trim();
  if (/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(clean)) {
    Linking.openURL(`mailto:${clean}`);
  }
}

const FIELD_TO_CONTACT_PROP = new Map<string, string>([
  ['email', 'email'],
  ['phone', 'directPhone'],
  ['description', 'notes'],
  ['team', 'department'],
  ['domains', 'linkedinUrl'],
]);

function buildContactUpdate(field: string, value: string): Record<string, string> {
  if (field === 'name') {
    const parts = value.split(' ');
    return { firstName: parts[0] || '', lastName: parts.slice(1).join(' ') || '' };
  }
  const prop = FIELD_TO_CONTACT_PROP.get(field);
  return prop ? { [prop]: value } : {};
}

function buildDetailFields(contact: Contact): DetailField[] {
  const phone = contact.directPhone || contact.mobilePhone;
  return [
    { key: 'domains', icon: Globe, label: 'Domains', editable: true, placeholder: 'Set Domains...' },
    { key: 'name', icon: Type, label: 'Name', editable: true, placeholder: 'Set Name...' },
    { key: 'description', icon: FileText, label: 'Description', editable: true, placeholder: 'Set Description...', multiline: true },
    { key: 'team', icon: Users, label: 'Team', editable: true, placeholder: 'Set a value...' },
    { key: 'email', icon: Mail, label: 'Email', editable: true, isLink: true, linkAction: contact.email ? () => emailContact(contact.email) : undefined, placeholder: 'Set Email...', keyboardType: 'email-address' },
    { key: 'phone', icon: Phone, label: 'Phone', editable: true, isLink: true, linkAction: phone ? () => callPhone(phone) : undefined, placeholder: 'Set Phone...', keyboardType: 'phone-pad' },
    { key: 'address', icon: MapPin, label: 'Address', editable: false, placeholder: 'Set Address...' },
  ];
}

function ContactHeader({ contact, name, paddingTop, colors }: Readonly<{ contact: Contact; name: string; paddingTop: number; colors: ThemeColors }>) {
  const phone = contact.directPhone || contact.mobilePhone;
  return (
    <View style={[styles.header, { paddingTop, borderBottomColor: colors.border || colors.divider }]}>
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
          onPress={contact.email ? () => emailContact(contact.email) : undefined}
          disabled={!contact.email}
        >
          <Mail size={16} color={contact.email ? '#6B7280' : '#E5E7EB'} strokeWidth={2} />
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.headerIconButton}
          onPress={phone ? () => callPhone(phone) : undefined}
          disabled={!phone}
        >
          <Phone size={16} color={phone ? '#6B7280' : '#E5E7EB'} strokeWidth={2} />
        </TouchableOpacity>
        <TouchableOpacity style={styles.headerIconButton}>
          <EllipsisVertical size={16} color="#6B7280" strokeWidth={2} />
        </TouchableOpacity>
        <TouchableOpacity style={styles.headerIconButton} onPress={() => router.back()}>
          <X size={18} color={colors.muted} strokeWidth={2} />
        </TouchableOpacity>
      </View>
    </View>
  );
}

function SidebarTabButton({ label, Icon, active, onPress, colors }: Readonly<{ label: string; Icon: LucideIcon; active: boolean; onPress: () => void; colors: ThemeColors }>) {
  const color = active ? colors.text : colors.muted;
  return (
    <TouchableOpacity style={styles.tab} onPress={onPress}>
      <View style={[styles.tabInner, active && styles.tabInnerActive]}>
        <Icon size={14} color={color} strokeWidth={2} />
        <Text style={[styles.tabText, { color }, active && styles.tabTextActive]}>
          {label}
        </Text>
      </View>
    </TouchableOpacity>
  );
}

function FieldValueEditor({ field, editValue, onChangeText, onSave, colors, inputRef }: Readonly<{ field: DetailField; editValue: string; onChangeText: (text: string) => void; onSave: () => void; colors: ThemeColors; inputRef: React.RefObject<TextInput | null> }>) {
  return (
    <TextInput
      ref={inputRef}
      style={[styles.fieldInput, { color: colors.text, borderColor: '#3B82F6', backgroundColor: colors.background }]}
      value={editValue}
      onChangeText={onChangeText}
      onBlur={onSave}
      onSubmitEditing={onSave}
      placeholder={field.placeholder}
      placeholderTextColor={colors.muted}
      keyboardType={field.keyboardType || 'default'}
      autoCapitalize={field.keyboardType === 'email-address' ? 'none' : 'sentences'}
      returnKeyType="done"
      autoFocus
    />
  );
}

function getFieldTextColor(field: DetailField, hasValue: boolean, colors: ThemeColors): string {
  if (!hasValue) return colors.muted;
  return field.isLink ? '#2563EB' : colors.text;
}

function FieldValueButton({ field, value, onStartEditing, colors }: Readonly<{ field: DetailField; value: string | null; onStartEditing: (key: string, value: string) => void; colors: ThemeColors }>) {
  const hasValue = !!value;
  const isActiveLink = !!field.isLink && hasValue;
  const handlePress = () => {
    if (isActiveLink && field.linkAction) field.linkAction();
    else if (field.editable) onStartEditing(field.key, value || '');
  };
  return (
    <TouchableOpacity
      onPress={handlePress}
      disabled={!field.editable && !isActiveLink}
      activeOpacity={0.6}
      style={styles.fieldValueTouchable}
    >
      <Text
        style={[
          styles.fieldValueText,
          { color: getFieldTextColor(field, hasValue, colors) },
          isActiveLink && styles.fieldValueLink,
        ]}
        numberOfLines={field.multiline ? 3 : 1}
      >
        {hasValue ? value : `Set ${field.label}...`}
      </Text>
    </TouchableOpacity>
  );
}

interface DetailsPanelProps {
  contact: Contact;
  fields: DetailField[];
  expanded: boolean;
  onToggleExpanded: () => void;
  editingField: string | null;
  editValue: string;
  onChangeEditValue: (text: string) => void;
  onSave: () => void;
  onStartEditing: (key: string, value: string) => void;
  inputRef: React.RefObject<TextInput | null>;
  colors: ThemeColors;
}

function DetailFieldRow({ field, contact, editingField, editValue, onChangeEditValue, onSave, onStartEditing, inputRef, colors }: Readonly<Omit<DetailsPanelProps, 'fields' | 'expanded' | 'onToggleExpanded'> & { field: DetailField }>) {
  const IconComponent = field.icon;
  const value = getFieldValue(contact, field.key);
  return (
    <View style={styles.fieldRow}>
      <View style={styles.fieldLabel}>
        <IconComponent size={16} color={colors.muted} strokeWidth={2} />
        <Text style={[styles.fieldLabelText, { color: colors.muted }]}>{field.label}</Text>
      </View>
      <View style={styles.fieldValue}>
        {editingField === field.key ? (
          <FieldValueEditor field={field} editValue={editValue} onChangeText={onChangeEditValue} onSave={onSave} colors={colors} inputRef={inputRef} />
        ) : (
          <FieldValueButton field={field} value={value} onStartEditing={onStartEditing} colors={colors} />
        )}
      </View>
    </View>
  );
}

function DetailsPanel({ fields, expanded, onToggleExpanded, colors, ...rowProps }: Readonly<DetailsPanelProps>) {
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <ScrollView style={styles.content} showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
      {/* Record Details Section */}
      <View style={styles.sectionWrapper}>
        <TouchableOpacity style={styles.sectionHeader} onPress={onToggleExpanded} activeOpacity={0.7}>
          <Chevron size={16} color={colors.muted} strokeWidth={2} />
          <Text style={[styles.sectionTitle, { color: colors.text }]}>Record Details</Text>
        </TouchableOpacity>

        {expanded && (
          <View style={styles.fieldsContainer}>
            {fields.map((field) => (
              <DetailFieldRow key={field.key} field={field} colors={colors} {...rowProps} />
            ))}
          </View>
        )}
      </View>
    </ScrollView>
  );
}

function CommentsEmpty({ colors }: Readonly<{ colors: ThemeColors }>) {
  return (
    <View style={styles.commentsContainer}>
      <View style={styles.commentsEmpty}>
        <MessageSquare size={24} color={colors.muted} strokeWidth={1.5} />
        <Text style={[styles.commentsEmptyTitle, { color: colors.muted }]}>No comments yet</Text>
        <Text style={[styles.commentsEmptySubtitle, { color: colors.muted }]}>Be the first to add a comment</Text>
      </View>
    </View>
  );
}

// The loading and not-found states share the same header + container shell;
// only the centered content differs.
function ContactShell({ colors, paddingTop, children }: Readonly<{ colors: ThemeColors; paddingTop: number; children: React.ReactNode }>) {
  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop, borderBottomColor: colors.border || colors.divider }]}>
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
}

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

  const loadContact = useCallback(async () => {
    try {
      setLoading(true);
      const loaded = await fetchContact(id as string);
      if (loaded) setContact(loaded);
    } catch {} finally { setLoading(false); }
  }, [id]);

  useEffect(() => { loadContact(); }, [loadContact]);

  const startEditing = useCallback((fieldKey: string, currentValue: string) => {
    setEditingField(fieldKey);
    setEditValue(currentValue);
    setTimeout(() => inputRef.current?.focus(), 50);
  }, []);

  const stopEditing = useCallback(() => {
    setEditingField(null);
    setEditValue('');
  }, []);

  const saveField = useCallback(async () => {
    if (!contact || !editingField || saving) return;
    const trimmed = editValue.trim();
    const originalValue = getFieldValue(contact, editingField);
    if (trimmed === (originalValue || '')) { stopEditing(); Keyboard.dismiss(); return; }
    // A sender with no contact record is shown from a placeholder whose id is
    // the email address; PATCH /people/<email> can only 404.
    if (contact.id.includes('@')) {
      Alert.alert('Not a contact', 'This sender isn’t in your contacts, so their details can’t be edited here.');
      stopEditing();
      return;
    }

    setSaving(true);
    try {
      const updateData = buildContactUpdate(editingField, trimmed);
      const { data: updatedData } = await appApiClient.patch<{ data: Contact }>('/people/' + contact.id, updateData);
      const updated = unwrapContact(updatedData);
      if (updated) setContact(updated);
    } catch {
      Alert.alert('Error', 'Could not save the change. Please try again.');
    } finally {
      setSaving(false);
      stopEditing();
    }
  }, [contact, editingField, editValue, saving, stopEditing]);

  if (loading) {
    return (
      <ContactShell colors={colors} paddingTop={insets.top + 8}>
        <MaterialSpinner size={32} strokeWidth={3} color={colors.text} spinning />
      </ContactShell>
    );
  }

  if (!contact) {
    return (
      <ContactShell colors={colors} paddingTop={insets.top + 8}>
        <Text style={[styles.emptyText, { color: colors.muted }]}>Contact not found</Text>
      </ContactShell>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header: Avatar + Name | Mail Phone ⋮ X */}
      <ContactHeader contact={contact} name={getContactName(contact)} paddingTop={insets.top + 8} colors={colors} />

      {/* Tabs: Details | Comments */}
      <View style={[styles.tabBar, { borderBottomColor: colors.border || colors.divider }]}>
        <SidebarTabButton label="Details" Icon={List} active={activeTab === 'details'} onPress={() => setActiveTab('details')} colors={colors} />
        <SidebarTabButton label="Comments" Icon={MessageSquare} active={activeTab === 'comments'} onPress={() => setActiveTab('comments')} colors={colors} />
      </View>

      {activeTab === 'details' ? (
        <DetailsPanel
          contact={contact}
          fields={buildDetailFields(contact)}
          expanded={recordDetailsExpanded}
          onToggleExpanded={() => setRecordDetailsExpanded(!recordDetailsExpanded)}
          editingField={editingField}
          editValue={editValue}
          onChangeEditValue={setEditValue}
          onSave={saveField}
          onStartEditing={startEditing}
          inputRef={inputRef}
          colors={colors}
        />
      ) : (
        <CommentsEmpty colors={colors} />
      )}
    </View>
  );
}
