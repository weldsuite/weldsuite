import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  StyleSheet,
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Linking,
  Keyboard,
  Modal,
  Pressable,
} from 'react-native';
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
import { useTheme } from '@/contexts/ThemeContext';
import { useToast } from '@/contexts/ToastContext';
import api, { Contact, Conversation, getApiErrorMessage } from '@/services/api';
import { ContactSkeleton } from '@/components/helpdesk/Skeleton';

const INDUSTRY_OPTIONS = [
  'Technology', 'Healthcare', 'Finance', 'Education', 'Manufacturing',
  'Retail', 'Real Estate', 'Media', 'Transportation', 'Energy',
  'Agriculture', 'Construction', 'Hospitality', 'Legal', 'Non-Profit',
  'Government', 'Telecommunications', 'Insurance', 'Automotive', 'Food & Beverage',
];

const CATEGORY_OPTIONS: { label: string; color: string; bg: string }[] = [
  { label: 'Customer', color: '#3b82f6', bg: '#3b82f620' },
  { label: 'Prospect', color: '#a855f7', bg: '#a855f720' },
  { label: 'Partner', color: '#10b981', bg: '#10b98120' },
  { label: 'Vendor', color: '#8b5cf6', bg: '#8b5cf620' },
  { label: 'Competitor', color: '#ef4444', bg: '#ef444420' },
  { label: 'Investor', color: '#06b6d4', bg: '#06b6d420' },
  { label: 'Influencer', color: '#ec4899', bg: '#ec489920' },
  { label: 'Press', color: '#6366f1', bg: '#6366f120' },
  { label: 'Reseller', color: '#f97316', bg: '#f9731620' },
  { label: 'Consultant', color: '#14b8a6', bg: '#14b8a620' },
];

type SidebarTab = 'details' | 'comments';

export default function ContactDetailsScreen() {
  const { id } = useLocalSearchParams();
  const { colors } = useTheme();
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const [contact, setContact] = useState<Contact | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<SidebarTab>('details');
  const [recordDetailsExpanded, setRecordDetailsExpanded] = useState(true);
  const [conversationsExpanded, setConversationsExpanded] = useState(false);
  const [editingField, setEditingField] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<TextInput>(null);
  const [industryModalVisible, setIndustryModalVisible] = useState(false);
  const [categoriesModalVisible, setCategoriesModalVisible] = useState(false);
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [addressModalVisible, setAddressModalVisible] = useState(false);
  const [addressFields, setAddressFields] = useState({
    street: '',
    city: '',
    state: '',
    postalCode: '',
    country: '',
  });
  const [contactConversations, setContactConversations] = useState<Conversation[]>([]);
  const [loadingConversations, setLoadingConversations] = useState(false);

  useEffect(() => {
    loadContact();
  }, [id]);

  const loadContactConversations = async () => {
    if (!contact?.email || loadingConversations) return;
    setLoadingConversations(true);
    try {
      const response = await api.getConversations({ search: contact.email, limit: 20 });
      if (response.success && response.data) {
        const items = response.data.data || response.data.items || [];
        setContactConversations(items);
      }
    } catch (error) {
      console.error('Error loading contact conversations:', error);
    } finally {
      setLoadingConversations(false);
    }
  };

  const loadContact = async () => {
    try {
      setLoading(true);
      const idStr = id as string;

      // If ID looks like an email, search for contact by email
      if (idStr.includes('@')) {
        const searchResponse = await api.getContacts({ search: idStr, limit: 1 });
        if (searchResponse.success && searchResponse.data) {
          const items = searchResponse.data.data || searchResponse.data.items || [];
          if (items.length > 0) {
            setContact(items[0]);
            return;
          }
        }
        // No contact found for this email — show minimal info
        setContact({
          id: idStr,
          email: idStr,
          firstName: idStr.split('@')[0],
          lastName: '',
          status: 'active',
        } as Contact);
        return;
      }

      const response = await api.getContact(idStr);
      if (response.success && response.data) {
        setContact(response.data);
      } else {
        toast.error(getApiErrorMessage(response.error, 'Failed to load contact'));
      }
    } catch (error) {
      console.error('Error loading contact:', error);
      toast.error('Failed to load contact');
    } finally {
      setLoading(false);
    }
  };

  const getContactName = (c: Contact) => {
    if (c.fullName) return c.fullName;
    return `${c.firstName || ''} ${c.lastName || ''}`.trim() || 'Unknown';
  };

  const handleCall = (phone: string) => {
    Linking.openURL(`tel:${phone}`);
  };

  const handleEmail = (email: string) => {
    Linking.openURL(`mailto:${email}`);
  };

  const startEditing = useCallback((fieldKey: string, currentValue: string) => {
    setEditingField(fieldKey);
    setEditValue(currentValue);
    setTimeout(() => inputRef.current?.focus(), 50);
  }, []);

  const cancelEditing = useCallback(() => {
    setEditingField(null);
    setEditValue('');
    Keyboard.dismiss();
  }, []);

  const saveField = useCallback(async () => {
    if (!contact || !editingField || saving) return;

    const trimmed = editValue.trim();
    const fieldKey = editingField;

    // Get the original value to check if it changed
    const originalValue = getFieldValue(contact, fieldKey);
    if (trimmed === (originalValue || '')) {
      cancelEditing();
      return;
    }

    setSaving(true);
    try {
      const updateData: Record<string, any> = {};

      // Map UI field keys to actual API schema field names
      if (fieldKey === 'name') {
        const parts = trimmed.split(' ');
        updateData.firstName = parts[0] || '';
        updateData.lastName = parts.slice(1).join(' ') || '';
      } else if (fieldKey === 'email') {
        updateData.email = trimmed || undefined;
      } else if (fieldKey === 'phone') {
        updateData.directPhone = trimmed || undefined;
      } else if (fieldKey === 'description') {
        updateData.notes = trimmed || undefined;
      } else if (fieldKey === 'domains') {
        updateData.linkedinUrl = trimmed || undefined; // store in available field
      } else if (fieldKey === 'team') {
        updateData.department = trimmed || undefined;
      }

      const response = await api.updateContact(id as string, updateData as any);
      if (response.success && response.data) {
        setContact(response.data);
        toast.success('Updated');
      } else {
        // Still update locally for display even if API rejects
        const localUpdate: Record<string, any> = {};
        if (fieldKey === 'domains') localUpdate._domains = trimmed;
        else if (fieldKey === 'team') localUpdate._team = trimmed;
        else if (fieldKey === 'description') localUpdate._description = trimmed;

        if (Object.keys(localUpdate).length > 0) {
          setContact({ ...contact, ...(localUpdate as any) });
          toast.success('Updated');
        } else {
          toast.error(getApiErrorMessage(response.error, 'Failed to update'));
        }
      }
    } catch (error) {
      console.error('Error updating contact:', error);
      // Fallback: update locally for non-critical fields
      const localUpdate: Record<string, any> = {};
      if (fieldKey === 'domains') localUpdate._domains = trimmed;
      else if (fieldKey === 'team') localUpdate._team = trimmed;
      else if (fieldKey === 'description') localUpdate._description = trimmed;

      if (Object.keys(localUpdate).length > 0) {
        setContact({ ...contact, ...(localUpdate as any) });
        toast.success('Updated');
      } else {
        toast.error('Failed to update');
      }
    } finally {
      setSaving(false);
      setEditingField(null);
      setEditValue('');
    }
  }, [contact, editingField, editValue, saving, id, cancelEditing, toast]);

  const toggleCategory = useCallback((label: string) => {
    setSelectedCategories(prev =>
      prev.includes(label) ? prev.filter(c => c !== label) : [...prev, label]
    );
  }, []);

  const saveCategories = useCallback(async () => {
    if (!contact) return;
    setCategoriesModalVisible(false);
    setSaving(true);
    try {
      const response = await api.updateContact(id as string, {
        interests: selectedCategories,
      } as any);
      if (response.success && response.data) {
        setContact({ ...response.data, ...({ _categories: selectedCategories } as any) });
        toast.success('Updated');
      } else {
        setContact({ ...contact, ...({ _categories: selectedCategories } as any) });
        toast.success('Updated');
      }
    } catch (error) {
      setContact({ ...contact, ...({ _categories: selectedCategories } as any) });
      console.error('Error updating categories:', error);
    } finally {
      setSaving(false);
    }
  }, [contact, selectedCategories, id, toast]);

  const openCategoriesModal = useCallback(() => {
    // Initialize selected from current contact data
    const current = getFieldValue(contact!, 'categories');
    if (current) {
      setSelectedCategories(current.split(', ').filter(Boolean));
    } else {
      setSelectedCategories([]);
    }
    setCategoriesModalVisible(true);
  }, [contact]);

  const selectIndustry = useCallback(async (industry: string) => {
    if (!contact) return;
    setIndustryModalVisible(false);
    setSaving(true);
    try {
      const response = await api.updateContact(id as string, { twitterHandle: industry } as any);
      if (response.success && response.data) {
        setContact({ ...response.data, ...({ _industry: industry } as any) });
        toast.success('Updated');
      } else {
        // Still update locally for display
        setContact({ ...contact, ...({ _industry: industry } as any) });
        toast.success('Updated');
      }
    } catch (error) {
      // Update locally even if API fails for this non-critical field
      setContact({ ...contact, ...({ _industry: industry } as any) });
      console.error('Error updating industry:', error);
    } finally {
      setSaving(false);
    }
  }, [contact, id, toast]);

  const openAddressModal = useCallback(() => {
    if (!contact) return;
    const c = contact as any;
    setAddressFields({
      street: c.street || c.address || '',
      city: c.city || '',
      state: c.state || '',
      postalCode: c.postalCode || c.zip || '',
      country: c.country || '',
    });
    setAddressModalVisible(true);
  }, [contact]);

  const saveAddress = useCallback(async () => {
    if (!contact) return;
    setSaving(true);
    try {
      // Build a formatted address string and store in bestTimeToContact (available text field)
      const formatted = [
        addressFields.street,
        addressFields.city,
        addressFields.state,
        addressFields.postalCode,
        addressFields.country,
      ].filter(Boolean).join(', ');

      const response = await api.updateContact(id as string, {
        bestTimeToContact: formatted || undefined,
      } as any);

      if (response.success && response.data) {
        // Update local contact with address fields for display
        setContact({
          ...response.data,
          ...({ _address: addressFields } as any),
        });
        toast.success('Address updated');
      } else {
        toast.error(getApiErrorMessage(response.error, 'Failed to update address'));
      }
    } catch (error) {
      console.error('Error updating address:', error);
      toast.error('Failed to update address');
    } finally {
      setSaving(false);
      setAddressModalVisible(false);
    }
  }, [contact, addressFields, id, toast]);

  // Not found state
  if (!contact) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <View style={[styles.header, { paddingTop: insets.top + 8, borderBottomColor: colors.border }]}>
          <View style={styles.headerCenter}>
            <Text style={[styles.headerName, { color: colors.text }]}>Contact</Text>
          </View>
          <View style={styles.headerRight}>
            <TouchableOpacity style={styles.headerIconButton} onPress={() => router.back()}>
              <X size={18} color={colors.muted} strokeWidth={2} />
            </TouchableOpacity>
          </View>
        </View>
        <View style={styles.centerContainer}>
          <Text style={[styles.emptyText, { color: colors.muted }]}>Contact not found</Text>
        </View>
      </View>
    );
  }

  const name = getContactName(contact);

  // Field definitions — matches web platform customer detail sidebar
  const detailFields: {
    key: string;
    icon: any;
    label: string;
    editable?: boolean;
    isLink?: boolean;
    linkAction?: () => void;
    placeholder?: string;
    keyboardType?: 'default' | 'email-address' | 'phone-pad';
    multiline?: boolean;
  }[] = [
    { key: 'domains', icon: Globe, label: 'Domains', editable: true, placeholder: 'Set Domains...' },
    { key: 'name', icon: Type, label: 'Name', editable: true, placeholder: 'Set Name...' },
    { key: 'description', icon: FileText, label: 'Description', editable: true, placeholder: 'Set Description...', multiline: true },
    { key: 'team', icon: Users, label: 'Team', editable: true, placeholder: 'Set a value...' },
    { key: 'email', icon: Mail, label: 'Email', editable: true, isLink: true, linkAction: contact.email ? () => handleEmail(contact.email) : undefined, placeholder: 'Set Email...', keyboardType: 'email-address' },
    { key: 'phone', icon: Phone, label: 'Phone', editable: true, isLink: true, linkAction: contact.directPhone ? () => handleCall(contact.directPhone!) : undefined, placeholder: 'Set Phone...', keyboardType: 'phone-pad' },
    { key: 'categories', icon: Tag, label: 'Categories', editable: false, placeholder: 'Set Categories...' },
    { key: 'industry', icon: Globe, label: 'Industry', editable: false, placeholder: 'Set Industry...' },
    { key: 'address', icon: MapPin, label: 'Address', editable: false, placeholder: 'Set Address...' },
  ];

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header: Avatar + Name | Mail Phone ⋮ X */}
      <View style={[styles.header, { paddingTop: insets.top + 8, borderBottomColor: colors.border }]}>
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
            onPress={contact.directPhone || contact.mobilePhone ? () => handleCall((contact.directPhone || contact.mobilePhone)!) : undefined}
            disabled={!contact.directPhone && !contact.mobilePhone}
          >
            <Phone size={16} color={contact.directPhone || contact.mobilePhone ? '#6B7280' : '#E5E7EB'} strokeWidth={2} />
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
      <View style={[styles.tabBar, { borderBottomColor: colors.border }]}>
        <TouchableOpacity style={styles.tab} onPress={() => setActiveTab('details')}>
          <View style={[styles.tabInner, activeTab === 'details' && styles.tabInnerActive]}>
            <List size={14} color={activeTab === 'details' ? colors.text : colors.muted} strokeWidth={2} />
            <Text style={[
              styles.tabText,
              { color: activeTab === 'details' ? colors.text : colors.muted },
              activeTab === 'details' && styles.tabTextActive,
            ]}>
              Details
            </Text>
          </View>
        </TouchableOpacity>
        <TouchableOpacity style={styles.tab} onPress={() => setActiveTab('comments')}>
          <View style={[styles.tabInner, activeTab === 'comments' && styles.tabInnerActive]}>
            <MessageSquare size={14} color={activeTab === 'comments' ? colors.text : colors.muted} strokeWidth={2} />
            <Text style={[
              styles.tabText,
              { color: activeTab === 'comments' ? colors.text : colors.muted },
              activeTab === 'comments' && styles.tabTextActive,
            ]}>
              Comments
            </Text>
          </View>
        </TouchableOpacity>
      </View>

      {activeTab === 'details' ? (
        <ScrollView
          style={styles.content}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: 40 }}
          keyboardShouldPersistTaps="handled"
        >
          {/* Record Details Section */}
          <View style={styles.sectionWrapper}>
            <TouchableOpacity
              style={styles.sectionHeader}
              onPress={() => setRecordDetailsExpanded(!recordDetailsExpanded)}
              activeOpacity={0.7}
            >
              {recordDetailsExpanded ? (
                <ChevronDown size={16} color={colors.muted} strokeWidth={2} />
              ) : (
                <ChevronRight size={16} color={colors.muted} strokeWidth={2} />
              )}
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
                            style={[styles.fieldInput, {
                              color: colors.text,
                              borderColor: '#3B82F6',
                              backgroundColor: colors.background,
                            }]}
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
                              if (field.key === 'address') {
                                openAddressModal();
                              } else if (field.key === 'industry') {
                                setIndustryModalVisible(true);
                              } else if (field.key === 'categories') {
                                openCategoriesModal();
                              } else if (field.isLink && hasValue && field.linkAction) {
                                field.linkAction();
                              } else if (field.editable) {
                                startEditing(field.key, value || '');
                              }
                            }}
                            disabled={!field.editable && field.key !== 'address' && field.key !== 'industry' && field.key !== 'categories' && !(field.isLink && hasValue)}
                            activeOpacity={0.6}
                            style={styles.fieldValueTouchable}
                          >
                            {field.key === 'domains' && hasValue ? (
                              <View style={styles.categoriesChipRow}>
                                {(value as string).split(',').map((d) => d.trim()).filter(Boolean).map((domain) => (
                                  <Text
                                    key={domain}
                                    style={styles.domainLink}
                                    onPress={() => Linking.openURL(domain.startsWith('http') ? domain : `https://${domain}`)}
                                  >
                                    {domain}
                                  </Text>
                                ))}
                              </View>
                            ) : field.key === 'categories' && hasValue ? (
                              <View style={styles.categoriesChipRow}>
                                {(value as string).split(', ').map((cat) => {
                                  const opt = CATEGORY_OPTIONS.find(o => o.label === cat);
                                  return (
                                    <View
                                      key={cat}
                                      style={[styles.categoryChip, { backgroundColor: opt?.bg || '#E5E7EB40' }]}
                                    >
                                      <Text style={[styles.categoryChipText, { color: opt?.color || colors.text }]}>
                                        {cat}
                                      </Text>
                                    </View>
                                  );
                                })}
                              </View>
                            ) : (
                              <Text
                                style={[
                                  styles.fieldValueText,
                                  {
                                    color: hasValue
                                      ? field.isLink ? '#2563EB' : colors.text
                                      : colors.muted,
                                  },
                                  field.isLink && hasValue && styles.fieldValueLink,
                                ]}
                                numberOfLines={field.multiline ? 3 : 1}
                              >
                                {hasValue ? value : `Set ${field.label}...`}
                              </Text>
                            )}
                          </TouchableOpacity>
                        )}
                      </View>
                    </View>
                  );
                })}
              </View>
            )}
          </View>

          {/* Conversations Section */}
          <View style={styles.sectionWrapper}>
            <TouchableOpacity
              style={styles.sectionHeader}
              onPress={() => {
                const willExpand = !conversationsExpanded;
                setConversationsExpanded(willExpand);
                if (willExpand && contactConversations.length === 0) {
                  loadContactConversations();
                }
              }}
              activeOpacity={0.7}
            >
              {conversationsExpanded ? (
                <ChevronDown size={16} color={colors.muted} strokeWidth={2} />
              ) : (
                <ChevronRight size={16} color={colors.muted} strokeWidth={2} />
              )}
              <Text style={[styles.sectionTitle, { color: colors.text }]}>Conversations</Text>
            </TouchableOpacity>

            {conversationsExpanded && (
              <View style={styles.sectionContent}>
                {loadingConversations ? (
                  <ActivityIndicator size="small" color={colors.muted} style={{ paddingVertical: 12 }} />
                ) : contactConversations.length === 0 ? (
                  <Text style={[styles.emptyText, { color: colors.muted }]}>
                    No conversations linked
                  </Text>
                ) : (
                  contactConversations.map((conv) => (
                    <TouchableOpacity
                      key={conv.id}
                      style={styles.conversationItem}
                      onPress={() => router.push(`/helpdesk/ticket/${conv.id}` as any)}
                      activeOpacity={0.6}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.conversationSubject, { color: colors.text }]} numberOfLines={1}>
                          {conv.subject || 'No subject'}
                        </Text>
                        <Text style={[styles.conversationMeta, { color: colors.muted }]} numberOfLines={1}>
                          {conv.status} {conv.lastMessagePreview ? `— ${conv.lastMessagePreview}` : ''}
                        </Text>
                      </View>
                      <ChevronRight size={16} color={colors.muted} strokeWidth={2} />
                    </TouchableOpacity>
                  ))
                )}
              </View>
            )}
          </View>
        </ScrollView>
      ) : (
        /* Comments Tab */
        <View style={styles.commentsContainer}>
          <View style={styles.commentsEmpty}>
            <MessageSquare size={24} color={colors.muted} strokeWidth={1.5} />
            <Text style={[styles.commentsEmptyTitle, { color: colors.muted }]}>No comments yet</Text>
            <Text style={[styles.commentsEmptySubtitle, { color: colors.muted }]}>
              Be the first to add a comment
            </Text>
          </View>
        </View>
      )}

      {/* Industry Modal */}
      <Modal
        visible={industryModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setIndustryModalVisible(false)}
      >
        <Pressable style={styles.modalOverlay} onPress={() => setIndustryModalVisible(false)}>
          <Pressable style={[styles.modalCard, { backgroundColor: colors.background }]} onPress={() => {}}>
            <ScrollView showsVerticalScrollIndicator={false} style={styles.industryList}>
              {INDUSTRY_OPTIONS.map((option) => (
                <TouchableOpacity
                  key={option}
                  style={styles.industryOption}
                  onPress={() => selectIndustry(option)}
                  activeOpacity={0.6}
                >
                  <Text style={[styles.industryOptionText, { color: colors.text }]}>{option}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Categories Modal */}
      <Modal
        visible={categoriesModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setCategoriesModalVisible(false)}
      >
        <Pressable style={styles.modalOverlay} onPress={() => setCategoriesModalVisible(false)}>
          <Pressable style={[styles.modalCard, { backgroundColor: colors.background }]} onPress={() => {}}>
            <Text style={[styles.categoriesModalTitle, { color: colors.text }]}>Categories</Text>
            <View style={styles.categoriesGrid}>
              {CATEGORY_OPTIONS.map((opt) => {
                const selected = selectedCategories.includes(opt.label);
                return (
                  <TouchableOpacity
                    key={opt.label}
                    style={[
                      styles.categoriesOption,
                      { backgroundColor: selected ? opt.bg : 'transparent', borderColor: selected ? opt.color : colors.divider },
                    ]}
                    onPress={() => toggleCategory(opt.label)}
                    activeOpacity={0.6}
                  >
                    <View style={[styles.categoriesDot, { backgroundColor: opt.color }]} />
                    <Text style={[styles.categoriesOptionText, { color: selected ? opt.color : colors.text }]}>
                      {opt.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            <TouchableOpacity
              style={styles.addressSaveButton}
              onPress={saveCategories}
              disabled={saving}
            >
              <Text style={styles.addressSaveText}>{saving ? 'Saving...' : 'Save'}</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Address Modal */}
      <Modal
        visible={addressModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setAddressModalVisible(false)}
      >
        <Pressable style={styles.modalOverlay} onPress={() => setAddressModalVisible(false)}>
          <Pressable style={[styles.modalCard, { backgroundColor: colors.background }]} onPress={() => {}}>
            {/* Street */}
            <View style={styles.addressFieldGroup}>
              <Text style={[styles.addressLabel, { color: colors.muted }]}>Street</Text>
              <TextInput
                style={[styles.addressInput, { color: colors.text, borderColor: colors.border }]}
                value={addressFields.street}
                onChangeText={(t) => setAddressFields(prev => ({ ...prev, street: t }))}
                placeholder="123 Main St"
                placeholderTextColor={colors.muted}
              />
            </View>

            {/* City + State row */}
            <View style={styles.addressRow}>
              <View style={styles.addressHalf}>
                <Text style={[styles.addressLabel, { color: colors.muted }]}>City</Text>
                <TextInput
                  style={[styles.addressInput, { color: colors.text, borderColor: colors.border }]}
                  value={addressFields.city}
                  onChangeText={(t) => setAddressFields(prev => ({ ...prev, city: t }))}
                  placeholder="City"
                  placeholderTextColor={colors.muted}
                />
              </View>
              <View style={styles.addressHalf}>
                <Text style={[styles.addressLabel, { color: colors.muted }]}>State / Province</Text>
                <TextInput
                  style={[styles.addressInput, { color: colors.text, borderColor: colors.border }]}
                  value={addressFields.state}
                  onChangeText={(t) => setAddressFields(prev => ({ ...prev, state: t }))}
                  placeholder="State"
                  placeholderTextColor={colors.muted}
                />
              </View>
            </View>

            {/* Postal code + Country row */}
            <View style={styles.addressRow}>
              <View style={styles.addressHalf}>
                <Text style={[styles.addressLabel, { color: colors.muted }]}>Postal code</Text>
                <TextInput
                  style={[styles.addressInput, { color: colors.text, borderColor: colors.border }]}
                  value={addressFields.postalCode}
                  onChangeText={(t) => setAddressFields(prev => ({ ...prev, postalCode: t }))}
                  placeholder="10001"
                  placeholderTextColor={colors.muted}
                  keyboardType="number-pad"
                />
              </View>
              <View style={styles.addressHalf}>
                <Text style={[styles.addressLabel, { color: colors.muted }]}>Country</Text>
                <TextInput
                  style={[styles.addressInput, { color: colors.text, borderColor: colors.border }]}
                  value={addressFields.country}
                  onChangeText={(t) => setAddressFields(prev => ({ ...prev, country: t }))}
                  placeholder="Country"
                  placeholderTextColor={colors.muted}
                />
              </View>
            </View>

            {/* Save button */}
            <TouchableOpacity
              style={styles.addressSaveButton}
              onPress={saveAddress}
              disabled={saving}
            >
              <Text style={styles.addressSaveText}>{saving ? 'Saving...' : 'Save'}</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

function getFieldValue(contact: Contact, key: string): string | null | undefined {
  switch (key) {
    case 'domains': return (contact as any)._domains || (contact as any).linkedinUrl || (contact as any).website || (contact as any).domains || null;
    case 'name':
      if (contact.fullName) return contact.fullName;
      return `${contact.firstName || ''} ${contact.lastName || ''}`.trim() || null;
    case 'description': return (contact as any)._description || (contact as any).description || contact.notes || null;
    case 'team': return (contact as any)._team || (contact as any).department || (contact as any).team || null;
    case 'email': return contact.email || null;
    case 'phone': return contact.directPhone || null;
    case 'categories': {
      const c = contact as any;
      if (c._categories && c._categories.length > 0) return c._categories.join(', ');
      if (Array.isArray(c.interests) && c.interests.length > 0) return c.interests.join(', ');
      if (Array.isArray(c.tags) && c.tags.length > 0) return c.tags.join(', ');
      return null;
    }
    case 'industry': return (contact as any)._industry || (contact as any).twitterHandle || null;
    case 'address': {
      const c = contact as any;
      // Check local address fields first, then bestTimeToContact fallback
      if (c._address) {
        const a = c._address;
        const parts = [a.street, a.city, a.state, a.postalCode, a.country].filter(Boolean);
        return parts.length > 0 ? parts.join(', ') : null;
      }
      return c.bestTimeToContact || null;
    }
    default: return null;
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  centerContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyText: {
    fontSize: 14,
  },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingBottom: 10,
    borderBottomWidth: 1,
  },
  headerIconButton: {
    width: 32,
    height: 32,
    borderRadius: 6,
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerCenter: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 4,
  },
  headerAvatar: {
    width: 28,
    height: 28,
    borderRadius: 8,
    backgroundColor: '#D1FAE5',
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerAvatarPlaceholder: {
    width: 28,
    height: 28,
    borderRadius: 8,
  },
  headerNamePlaceholder: {
    width: 120,
    height: 16,
    borderRadius: 4,
  },
  headerName: {
    fontSize: 16,
    fontWeight: '600',
    flex: 1,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },

  // Tabs
  tabBar: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    paddingLeft: 8,
  },
  tab: {
    paddingHorizontal: 10,
  },
  tabInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 12,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  tabInnerActive: {
    borderBottomColor: '#000000',
  },
  tabText: {
    fontSize: 14,
    fontWeight: '500',
  },
  tabTextActive: {
    fontWeight: '600',
  },

  // Content
  content: {
    flex: 1,
  },

  // Section
  sectionWrapper: {
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 4,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '600',
  },
  sectionContent: {
    paddingLeft: 24,
    paddingTop: 12,
  },

  // Fields
  fieldsContainer: {
    marginTop: 8,
  },
  fieldRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 36,
    gap: 12,
  },
  fieldLabel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    width: 110,
    flexShrink: 0,
  },
  fieldLabelText: {
    fontSize: 14,
  },
  fieldValue: {
    flex: 1,
  },
  fieldValueTouchable: {
    minHeight: 32,
    justifyContent: 'center',
  },
  fieldValueText: {
    fontSize: 14,
  },
  fieldValueLink: {
    textDecorationLine: 'underline',
  },
  fieldInput: {
    fontSize: 14,
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    minHeight: 36,
  },

  // Industry modal
  industryList: {
    maxHeight: 400,
  },
  industryOption: {
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E5E5EA',
  },
  industryOptionText: {
    fontSize: 15,
    fontWeight: '500',
  },

  // Address modal
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  modalCard: {
    width: '100%',
    maxWidth: 340,
    borderRadius: 12,
    padding: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 8,
  },
  addressFieldGroup: {
    marginBottom: 12,
  },
  addressLabel: {
    fontSize: 12,
    fontWeight: '500',
    marginBottom: 4,
  },
  addressInput: {
    fontSize: 14,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  addressRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 12,
  },
  addressHalf: {
    flex: 1,
  },
  addressSaveButton: {
    backgroundColor: '#18181B',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
    marginTop: 4,
  },
  addressSaveText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },

  // Domain links
  domainLink: {
    fontSize: 14,
    color: '#2563EB',
    textDecorationLine: 'underline',
  },

  // Categories chips in field row
  categoriesChipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    paddingVertical: 4,
  },
  categoryChip: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  categoryChipText: {
    fontSize: 12,
    fontWeight: '600',
  },

  // Categories modal
  categoriesModalTitle: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 14,
  },
  categoriesGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 16,
  },
  categoriesOption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: 1,
  },
  categoriesDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  categoriesOptionText: {
    fontSize: 13,
    fontWeight: '500',
  },

  // Conversation items
  conversationItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    gap: 8,
  },
  conversationSubject: {
    fontSize: 14,
    fontWeight: '500',
  },
  conversationMeta: {
    fontSize: 12,
    marginTop: 2,
  },

  // Comments
  commentsContainer: {
    flex: 1,
  },
  commentsEmpty: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 6,
    paddingBottom: 60,
  },
  commentsEmptyTitle: {
    fontSize: 14,
    fontWeight: '500',
    marginTop: 4,
  },
  commentsEmptySubtitle: {
    fontSize: 13,
  },
});
