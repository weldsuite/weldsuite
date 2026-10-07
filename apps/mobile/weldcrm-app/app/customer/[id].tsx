import React, { useState, useEffect, useCallback } from 'react';
import {
  StyleSheet,
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Alert,
  Linking,
  KeyboardAvoidingView,
  Platform,
  type TextInputProps,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useObserve } from 'expo-observe';
import { useLocalSearchParams, router, Stack } from 'expo-router';
import {
  ArrowLeft,
  User,
  Mail,
  Phone,
  Building2,
  Globe,
  FileText,
  Save,
  X,
  Edit3,
  Trash2,
  type LucideIcon,
} from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { api, type CustomerRecord } from '@/services/api';
import { hideAppSplash } from '@/utils/splash';

type ThemeColors = ReturnType<typeof useTheme>['colors'];

interface CustomerFormData {
  firstName: string;
  lastName: string;
  fullName: string;
  companyName: string;
  email: string;
  phone: string;
  mobile: string;
  website: string;
  notes: string;
}

type EditableField = Exclude<keyof CustomerFormData, 'fullName'>;

interface FieldConfig {
  key: EditableField;
  label: string;
  icon: LucideIcon;
  placeholder: string;
  required?: boolean;
  multiline?: boolean;
  inputProps?: TextInputProps;
  /** How the read-only value is styled: never, always, or only when filled in as a link. */
  viewLink?: 'always' | 'whenFilled';
  onPressView?: () => void;
}

const EMPTY_FORM: CustomerFormData = {
  firstName: '',
  lastName: '',
  fullName: '',
  companyName: '',
  email: '',
  phone: '',
  mobile: '',
  website: '',
  notes: '',
};

const formFromCustomer = (found: CustomerRecord): CustomerFormData => ({
  firstName: found.firstName || '',
  lastName: found.lastName || '',
  fullName: found.fullName || '',
  companyName: found.companyName || '',
  email: found.email || '',
  phone: found.phone || '',
  mobile: found.mobile || '',
  website: found.website || '',
  notes: found.notes || '',
});

const resolveDisplayName = (formData: CustomerFormData, name?: string) => {
  if (formData.fullName) return formData.fullName;
  if (formData.firstName || formData.lastName) {
    return [formData.firstName, formData.lastName].filter(Boolean).join(' ');
  }
  if (formData.companyName) return formData.companyName;
  return formData.email || name || 'Customer';
};

const initialsOf = (displayName: string) =>
  displayName.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);

const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

interface CustomerFieldProps {
  config: FieldConfig;
  value: string;
  isEditing: boolean;
  colors: ThemeColors;
  onChange: (key: EditableField, text: string) => void;
}

const CustomerField = ({ config, value, isEditing, colors, onChange }: CustomerFieldProps) => {
  const Icon = config.icon;
  const isLink = config.viewLink === 'always' || (config.viewLink === 'whenFilled' && !!value);
  const valueText = (
    <Text style={[styles.fieldValue, isLink ? styles.linkText : { color: colors.text }]}>{value || '-'}</Text>
  );

  return (
    <View style={styles.field}>
      <View style={styles.fieldLabel}>
        <Icon size={16} color={colors.muted} />
        <Text style={[styles.fieldLabelText, { color: colors.muted }]}>{config.label}</Text>
        {isEditing && config.required && <Text style={styles.required}>*</Text>}
      </View>
      {isEditing ? (
        <TextInput
          style={[config.multiline ? styles.textArea : styles.input, { color: colors.text, borderColor: colors.divider }]}
          value={value}
          onChangeText={(text) => onChange(config.key, text)}
          placeholder={config.placeholder}
          placeholderTextColor={colors.muted}
          {...config.inputProps}
        />
      ) : (
        <ViewValue onPress={config.onPressView}>{valueText}</ViewValue>
      )}
    </View>
  );
};

const ViewValue = ({ onPress, children }: { onPress?: () => void; children: React.ReactNode }) =>
  onPress ? <TouchableOpacity onPress={onPress}>{children}</TouchableOpacity> : <>{children}</>;

interface HeaderActionsProps {
  isEditing: boolean;
  saving: boolean;
  colors: ThemeColors;
  onCancel: () => void;
  onSave: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

const HeaderActions = ({ isEditing, saving, colors, onCancel, onSave, onEdit, onDelete }: HeaderActionsProps) => {
  if (isEditing) {
    return (
      <>
        <TouchableOpacity onPress={onCancel} style={styles.headerButton}>
          <X size={22} color={colors.muted} />
        </TouchableOpacity>
        <TouchableOpacity onPress={onSave} style={styles.headerButton} disabled={saving}>
          <Save size={22} color={saving ? colors.muted : '#7C3AED'} />
        </TouchableOpacity>
      </>
    );
  }
  return (
    <>
      <TouchableOpacity onPress={onEdit} style={styles.headerButton}>
        <Edit3 size={22} color={colors.text} />
      </TouchableOpacity>
      <TouchableOpacity onPress={onDelete} style={styles.headerButton}>
        <Trash2 size={22} color="#EF4444" />
      </TouchableOpacity>
    </>
  );
};

interface ProfileHeaderProps {
  displayName: string;
  companyName: string;
  isEditing: boolean;
  colors: ThemeColors;
  onCall: () => void;
  onEmail: () => void;
}

const ProfileHeader = ({ displayName, companyName, isEditing, colors, onCall, onEmail }: ProfileHeaderProps) => (
  <View style={styles.profileHeader}>
    <View style={styles.avatar}>
      <Text style={styles.avatarText}>{initialsOf(displayName)}</Text>
    </View>
    <Text style={[styles.profileName, { color: colors.text }]}>{displayName}</Text>
    {!!companyName && !isEditing && (
      <Text style={[styles.profileCompany, { color: colors.muted }]}>{companyName}</Text>
    )}

    {!isEditing && (
      <View style={styles.quickActions}>
        <TouchableOpacity
          style={[styles.quickActionButton, { backgroundColor: colors.background, borderColor: colors.divider }]}
          onPress={onCall}
        >
          <Phone size={20} color="#7C3AED" />
          <Text style={[styles.quickActionText, { color: colors.text }]}>Call</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.quickActionButton, { backgroundColor: colors.background, borderColor: colors.divider }]}
          onPress={onEmail}
        >
          <Mail size={20} color="#7C3AED" />
          <Text style={[styles.quickActionText, { color: colors.text }]}>Email</Text>
        </TouchableOpacity>
      </View>
    )}
  </View>
);

const CustomerInfoSection = ({ customer, colors }: { customer: CustomerRecord; colors: ThemeColors }) => (
  <View style={styles.section}>
    <Text style={[styles.sectionTitle, { color: colors.text }]}>Customer Info</Text>

    <View style={styles.infoRow}>
      <Text style={[styles.infoLabel, { color: colors.muted }]}>Status</Text>
      <View style={[styles.statusBadge, { backgroundColor: '#10B98115' }]}>
        <Text style={[styles.statusText, { color: '#10B981' }]}>
          {customer.status ? capitalize(customer.status) : 'Active'}
        </Text>
      </View>
    </View>

    <View style={styles.infoRow}>
      <Text style={[styles.infoLabel, { color: colors.muted }]}>Type</Text>
      <Text style={[styles.infoValue, { color: colors.text }]}>
        {customer.type === 'b2b' ? 'Business' : 'Individual'}
      </Text>
    </View>

    <View style={styles.infoRow}>
      <Text style={[styles.infoLabel, { color: colors.muted }]}>Created</Text>
      <Text style={[styles.infoValue, { color: colors.text }]}>
        {new Date(customer.createdAt).toLocaleDateString()}
      </Text>
    </View>

    <View style={styles.infoRow}>
      <Text style={[styles.infoLabel, { color: colors.muted }]}>Last Updated</Text>
      <Text style={[styles.infoValue, { color: colors.text }]}>
        {new Date(customer.updatedAt).toLocaleDateString()}
      </Text>
    </View>
  </View>
);

export default function CustomerDetailPage() {
  const { markInteractive } = useObserve();
  const { id, name, edit } = useLocalSearchParams<{ id: string; name?: string; edit?: string }>();
  const { colors } = useTheme();
  const toast = useToast();
  const insets = useSafeAreaInsets();

  const [customer, setCustomer] = useState<CustomerRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [isEditing, setIsEditing] = useState(edit === 'true');

  const [formData, setFormData] = useState<CustomerFormData>(EMPTY_FORM);

  const loadCustomer = useCallback(async () => {
    try {
      setLoading(true);
      const response = await api.getCustomerById(id);
      if (response.success && response.data) {
        const found = response.data;
        setCustomer(found);
        setFormData(formFromCustomer(found));
      }
    } catch (error) {
      console.error('Error loading customer:', error);
      toast.error('Failed to load customer');
    } finally {
      setLoading(false);
    }
  }, [id, toast]);

  useEffect(() => {
    loadCustomer();
  }, [loadCustomer]);

  useEffect(() => {
    if (!loading) {
      hideAppSplash();
      markInteractive();
    }
  }, [loading, markInteractive]);

  const getDisplayName = () => resolveDisplayName(formData, name);

  const handleFieldChange = (key: EditableField, text: string) => {
    setFormData(prev => ({ ...prev, [key]: text }));
  };

  const handleSave = () => {
    if (!formData.email) {
      toast.error('Email is required');
      return;
    }

    setSaving(true);
    try {
      // TODO: wire up PUT /crm/customers/:id
      setCustomer(prev => prev ? { ...prev, ...formData } : null);
      setIsEditing(false);
      toast.success('Customer updated');
    } catch (error) {
      console.error('Error saving customer:', error);
      toast.error('Failed to save customer');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = () => {
    Alert.alert(
      'Delete Customer',
      `Are you sure you want to delete ${getDisplayName()}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            // TODO: wire up DELETE /crm/customers/:id
            toast.success('Customer deleted');
            router.back();
          },
        },
      ]
    );
  };

  const handleCall = () => {
    const phoneNumber = formData.phone || formData.mobile;
    if (phoneNumber) {
      Linking.openURL(`tel:${phoneNumber}`);
    } else {
      toast.error('No phone number available');
    }
  };

  const handleEmail = () => {
    if (formData.email) {
      Linking.openURL(`mailto:${formData.email}`);
    }
  };

  if (loading) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={[styles.header, { borderBottomColor: colors.divider }]}>
          <TouchableOpacity onPress={() => router.back()} style={styles.headerButton}>
            <ArrowLeft size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={[styles.headerTitle, { color: colors.text }]}>Customer</Text>
          <View style={styles.headerRight} />
        </View>
        <View style={styles.centerContainer}>
          <ActivityIndicator size="large" color={colors.text} />
        </View>
      </View>
    );
  }

  const fields: FieldConfig[] = [
    { key: 'firstName', label: 'First Name', icon: User, placeholder: 'Enter first name' },
    { key: 'lastName', label: 'Last Name', icon: User, placeholder: 'Enter last name' },
    { key: 'companyName', label: 'Company', icon: Building2, placeholder: 'Enter company name' },
    {
      key: 'email',
      label: 'Email',
      icon: Mail,
      placeholder: 'Enter email',
      required: true,
      inputProps: { keyboardType: 'email-address', autoCapitalize: 'none' },
      viewLink: 'always',
      onPressView: handleEmail,
    },
    {
      key: 'phone',
      label: 'Phone',
      icon: Phone,
      placeholder: 'Enter phone number',
      inputProps: { keyboardType: 'phone-pad' },
      viewLink: 'whenFilled',
      onPressView: handleCall,
    },
    {
      key: 'mobile',
      label: 'Mobile',
      icon: Phone,
      placeholder: 'Enter mobile number',
      inputProps: { keyboardType: 'phone-pad' },
    },
    {
      key: 'website',
      label: 'Website',
      icon: Globe,
      placeholder: 'Enter website URL',
      inputProps: { keyboardType: 'url', autoCapitalize: 'none' },
      viewLink: 'whenFilled',
    },
    {
      key: 'notes',
      label: 'Notes',
      icon: FileText,
      placeholder: 'Add notes...',
      multiline: true,
      inputProps: { multiline: true, numberOfLines: 4, textAlignVertical: 'top' },
    },
  ];

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: colors.background }]}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <Stack.Screen options={{ headerShown: false }} />

      <View style={[styles.header, { paddingTop: insets.top, borderBottomColor: colors.divider }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.headerButton}>
          <ArrowLeft size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]} numberOfLines={1}>
          {isEditing ? 'Edit Customer' : getDisplayName()}
        </Text>
        <View style={styles.headerRight}>
          <HeaderActions
            isEditing={isEditing}
            saving={saving}
            colors={colors}
            onCancel={() => setIsEditing(false)}
            onSave={handleSave}
            onEdit={() => setIsEditing(true)}
            onDelete={handleDelete}
          />
        </View>
      </View>

      <ScrollView style={styles.content} showsVerticalScrollIndicator={false}>
        <ProfileHeader
          displayName={getDisplayName()}
          companyName={formData.companyName}
          isEditing={isEditing}
          colors={colors}
          onCall={handleCall}
          onEmail={handleEmail}
        />

        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>
            {isEditing ? 'Edit Details' : 'Contact Information'}
          </Text>

          {fields.map(config => (
            <CustomerField
              key={config.key}
              config={config}
              value={formData[config.key]}
              isEditing={isEditing}
              colors={colors}
              onChange={handleFieldChange}
            />
          ))}
        </View>

        {!isEditing && customer && <CustomerInfoSection customer={customer} colors={colors} />}

        <View style={{ height: 40 }} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  centerContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingBottom: 12, borderBottomWidth: 1 },
  headerTitle: { flex: 1, fontSize: 17, fontWeight: '600', textAlign: 'center', marginHorizontal: 8 },
  headerButton: { padding: 8 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  content: { flex: 1 },
  profileHeader: { alignItems: 'center', paddingVertical: 24, paddingHorizontal: 16 },
  avatar: { width: 80, height: 80, borderRadius: 40, backgroundColor: '#EDE9FE', justifyContent: 'center', alignItems: 'center', marginBottom: 16 },
  avatarText: { fontSize: 28, fontWeight: '600', color: '#7C3AED' },
  profileName: { fontSize: 22, fontWeight: '600', marginBottom: 4 },
  profileCompany: { fontSize: 15 },
  quickActions: { flexDirection: 'row', gap: 12, marginTop: 20 },
  quickActionButton: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 20, paddingVertical: 10, borderRadius: 8, borderWidth: 1 },
  quickActionText: { fontSize: 14, fontWeight: '500' },
  section: { paddingHorizontal: 16, paddingVertical: 16 },
  sectionTitle: { fontSize: 16, fontWeight: '600', marginBottom: 16 },
  field: { marginBottom: 16 },
  fieldLabel: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  fieldLabelText: { fontSize: 13, fontWeight: '500' },
  required: { color: '#EF4444', fontSize: 13 },
  fieldValue: { fontSize: 15, paddingVertical: 4 },
  linkText: { color: '#7C3AED' },
  input: { fontSize: 15, borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10 },
  textArea: { fontSize: 15, borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, minHeight: 100 },
  infoRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#E4E4E7' },
  infoLabel: { fontSize: 14 },
  infoValue: { fontSize: 14, fontWeight: '500' },
  statusBadge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 },
  statusText: { fontSize: 13, fontWeight: '500' },
});
