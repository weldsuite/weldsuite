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
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, router, Stack } from 'expo-router';
import {
  ArrowLeft,
  User,
  Mail,
  Phone,
  Building2,
  Globe,
  MapPin,
  FileText,
  Save,
  X,
  Edit3,
  Trash2,
} from 'lucide-react-native';
import { useTheme } from '@/contexts/ThemeContext';
import { useToast } from '@/contexts/ToastContext';
import { api, CustomerRecord } from '@/services/api';

export default function CustomerDetailPage() {
  const { id, name, edit } = useLocalSearchParams<{ id: string; name?: string; edit?: string }>();
  const { colors } = useTheme();
  const toast = useToast();
  const insets = useSafeAreaInsets();

  const [customer, setCustomer] = useState<CustomerRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [isEditing, setIsEditing] = useState(edit === 'true');

  // Form state
  const [formData, setFormData] = useState({
    firstName: '',
    lastName: '',
    fullName: '',
    companyName: '',
    email: '',
    phone: '',
    mobile: '',
    website: '',
    notes: '',
  });

  const loadCustomer = useCallback(async () => {
    try {
      setLoading(true);
      const response = await api.getCrmCustomerRecords({ limit: 100 });
      if (response.success && response.data) {
        const customers = response.data.items || response.data.data || [];
        const found = customers.find(c => c.id === id);
        if (found) {
          setCustomer(found);
          setFormData({
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
        }
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

  const getDisplayName = () => {
    if (formData.fullName) return formData.fullName;
    if (formData.firstName || formData.lastName) {
      return [formData.firstName, formData.lastName].filter(Boolean).join(' ');
    }
    if (formData.companyName) return formData.companyName;
    return formData.email || name || 'Customer';
  };

  const getInitials = () => {
    const displayName = getDisplayName();
    return displayName.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
  };

  const handleSave = async () => {
    if (!formData.email) {
      toast.error('Email is required');
      return;
    }

    setSaving(true);
    try {
      // TODO: Implement update API call
      // await api.updateCustomer(id, formData);

      // For now, update local state
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
          onPress: async () => {
            // TODO: Implement delete API call
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

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: colors.background }]}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <Stack.Screen options={{ headerShown: false }} />

      {/* Custom Header with Safe Area */}
      <View style={[styles.header, { paddingTop: insets.top, borderBottomColor: colors.divider }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.headerButton}>
          <ArrowLeft size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]} numberOfLines={1}>
          {isEditing ? 'Edit Customer' : getDisplayName()}
        </Text>
        <View style={styles.headerRight}>
          {isEditing ? (
            <>
              <TouchableOpacity onPress={() => setIsEditing(false)} style={styles.headerButton}>
                <X size={22} color={colors.muted} />
              </TouchableOpacity>
              <TouchableOpacity onPress={handleSave} style={styles.headerButton} disabled={saving}>
                <Save size={22} color={saving ? colors.muted : '#3B82F6'} />
              </TouchableOpacity>
            </>
          ) : (
            <>
              <TouchableOpacity onPress={() => setIsEditing(true)} style={styles.headerButton}>
                <Edit3 size={22} color={colors.text} />
              </TouchableOpacity>
              <TouchableOpacity onPress={handleDelete} style={styles.headerButton}>
                <Trash2 size={22} color="#EF4444" />
              </TouchableOpacity>
            </>
          )}
        </View>
      </View>

      <ScrollView style={styles.content} showsVerticalScrollIndicator={false}>
        {/* Profile Header */}
        <View style={styles.profileHeader}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{getInitials()}</Text>
          </View>
          <Text style={[styles.profileName, { color: colors.text }]}>{getDisplayName()}</Text>
          {formData.companyName && !isEditing && (
            <Text style={[styles.profileCompany, { color: colors.muted }]}>{formData.companyName}</Text>
          )}

          {/* Quick Actions */}
          {!isEditing && (
            <View style={styles.quickActions}>
              <TouchableOpacity
                style={[styles.quickActionButton, { backgroundColor: colors.background, borderColor: colors.divider }]}
                onPress={handleCall}
              >
                <Phone size={20} color="#3B82F6" />
                <Text style={[styles.quickActionText, { color: colors.text }]}>Call</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.quickActionButton, { backgroundColor: colors.background, borderColor: colors.divider }]}
                onPress={handleEmail}
              >
                <Mail size={20} color="#3B82F6" />
                <Text style={[styles.quickActionText, { color: colors.text }]}>Email</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>

        {/* Form / Details */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>
            {isEditing ? 'Edit Details' : 'Contact Information'}
          </Text>

          {/* First Name */}
          <View style={styles.field}>
            <View style={styles.fieldLabel}>
              <User size={16} color={colors.muted} />
              <Text style={[styles.fieldLabelText, { color: colors.muted }]}>First Name</Text>
            </View>
            {isEditing ? (
              <TextInput
                style={[styles.input, { color: colors.text, borderColor: colors.divider }]}
                value={formData.firstName}
                onChangeText={(text) => setFormData(prev => ({ ...prev, firstName: text }))}
                placeholder="Enter first name"
                placeholderTextColor={colors.muted}
              />
            ) : (
              <Text style={[styles.fieldValue, { color: colors.text }]}>
                {formData.firstName || '-'}
              </Text>
            )}
          </View>

          {/* Last Name */}
          <View style={styles.field}>
            <View style={styles.fieldLabel}>
              <User size={16} color={colors.muted} />
              <Text style={[styles.fieldLabelText, { color: colors.muted }]}>Last Name</Text>
            </View>
            {isEditing ? (
              <TextInput
                style={[styles.input, { color: colors.text, borderColor: colors.divider }]}
                value={formData.lastName}
                onChangeText={(text) => setFormData(prev => ({ ...prev, lastName: text }))}
                placeholder="Enter last name"
                placeholderTextColor={colors.muted}
              />
            ) : (
              <Text style={[styles.fieldValue, { color: colors.text }]}>
                {formData.lastName || '-'}
              </Text>
            )}
          </View>

          {/* Company */}
          <View style={styles.field}>
            <View style={styles.fieldLabel}>
              <Building2 size={16} color={colors.muted} />
              <Text style={[styles.fieldLabelText, { color: colors.muted }]}>Company</Text>
            </View>
            {isEditing ? (
              <TextInput
                style={[styles.input, { color: colors.text, borderColor: colors.divider }]}
                value={formData.companyName}
                onChangeText={(text) => setFormData(prev => ({ ...prev, companyName: text }))}
                placeholder="Enter company name"
                placeholderTextColor={colors.muted}
              />
            ) : (
              <Text style={[styles.fieldValue, { color: colors.text }]}>
                {formData.companyName || '-'}
              </Text>
            )}
          </View>

          {/* Email */}
          <View style={styles.field}>
            <View style={styles.fieldLabel}>
              <Mail size={16} color={colors.muted} />
              <Text style={[styles.fieldLabelText, { color: colors.muted }]}>Email</Text>
              {isEditing && <Text style={styles.required}>*</Text>}
            </View>
            {isEditing ? (
              <TextInput
                style={[styles.input, { color: colors.text, borderColor: colors.divider }]}
                value={formData.email}
                onChangeText={(text) => setFormData(prev => ({ ...prev, email: text }))}
                placeholder="Enter email"
                placeholderTextColor={colors.muted}
                keyboardType="email-address"
                autoCapitalize="none"
              />
            ) : (
              <TouchableOpacity onPress={handleEmail}>
                <Text style={[styles.fieldValue, styles.linkText]}>
                  {formData.email || '-'}
                </Text>
              </TouchableOpacity>
            )}
          </View>

          {/* Phone */}
          <View style={styles.field}>
            <View style={styles.fieldLabel}>
              <Phone size={16} color={colors.muted} />
              <Text style={[styles.fieldLabelText, { color: colors.muted }]}>Phone</Text>
            </View>
            {isEditing ? (
              <TextInput
                style={[styles.input, { color: colors.text, borderColor: colors.divider }]}
                value={formData.phone}
                onChangeText={(text) => setFormData(prev => ({ ...prev, phone: text }))}
                placeholder="Enter phone number"
                placeholderTextColor={colors.muted}
                keyboardType="phone-pad"
              />
            ) : (
              <TouchableOpacity onPress={handleCall}>
                <Text style={[styles.fieldValue, formData.phone ? styles.linkText : { color: colors.text }]}>
                  {formData.phone || '-'}
                </Text>
              </TouchableOpacity>
            )}
          </View>

          {/* Mobile */}
          <View style={styles.field}>
            <View style={styles.fieldLabel}>
              <Phone size={16} color={colors.muted} />
              <Text style={[styles.fieldLabelText, { color: colors.muted }]}>Mobile</Text>
            </View>
            {isEditing ? (
              <TextInput
                style={[styles.input, { color: colors.text, borderColor: colors.divider }]}
                value={formData.mobile}
                onChangeText={(text) => setFormData(prev => ({ ...prev, mobile: text }))}
                placeholder="Enter mobile number"
                placeholderTextColor={colors.muted}
                keyboardType="phone-pad"
              />
            ) : (
              <Text style={[styles.fieldValue, { color: colors.text }]}>
                {formData.mobile || '-'}
              </Text>
            )}
          </View>

          {/* Website */}
          <View style={styles.field}>
            <View style={styles.fieldLabel}>
              <Globe size={16} color={colors.muted} />
              <Text style={[styles.fieldLabelText, { color: colors.muted }]}>Website</Text>
            </View>
            {isEditing ? (
              <TextInput
                style={[styles.input, { color: colors.text, borderColor: colors.divider }]}
                value={formData.website}
                onChangeText={(text) => setFormData(prev => ({ ...prev, website: text }))}
                placeholder="Enter website URL"
                placeholderTextColor={colors.muted}
                keyboardType="url"
                autoCapitalize="none"
              />
            ) : (
              <Text style={[styles.fieldValue, formData.website ? styles.linkText : { color: colors.text }]}>
                {formData.website || '-'}
              </Text>
            )}
          </View>

          {/* Notes */}
          <View style={styles.field}>
            <View style={styles.fieldLabel}>
              <FileText size={16} color={colors.muted} />
              <Text style={[styles.fieldLabelText, { color: colors.muted }]}>Notes</Text>
            </View>
            {isEditing ? (
              <TextInput
                style={[styles.textArea, { color: colors.text, borderColor: colors.divider }]}
                value={formData.notes}
                onChangeText={(text) => setFormData(prev => ({ ...prev, notes: text }))}
                placeholder="Add notes..."
                placeholderTextColor={colors.muted}
                multiline
                numberOfLines={4}
                textAlignVertical="top"
              />
            ) : (
              <Text style={[styles.fieldValue, { color: colors.text }]}>
                {formData.notes || '-'}
              </Text>
            )}
          </View>
        </View>

        {/* Customer Info */}
        {!isEditing && customer && (
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>Customer Info</Text>

            <View style={styles.infoRow}>
              <Text style={[styles.infoLabel, { color: colors.muted }]}>Status</Text>
              <View style={[styles.statusBadge, { backgroundColor: '#10B98115' }]}>
                <Text style={[styles.statusText, { color: '#10B981' }]}>
                  {customer.status ? customer.status.charAt(0).toUpperCase() + customer.status.slice(1) : 'Active'}
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
        )}

        <View style={{ height: 40 }} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
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
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingBottom: 12,
    borderBottomWidth: 1,
  },
  headerTitle: {
    flex: 1,
    fontSize: 17,
    fontWeight: '600',
    textAlign: 'center',
    marginHorizontal: 8,
  },
  headerButton: {
    padding: 8,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  content: {
    flex: 1,
  },
  profileHeader: {
    alignItems: 'center',
    paddingVertical: 24,
    paddingHorizontal: 16,
  },
  avatar: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: '#E0E7FF',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 16,
  },
  avatarText: {
    fontSize: 28,
    fontWeight: '600',
    color: '#4F46E5',
  },
  profileName: {
    fontSize: 22,
    fontWeight: '600',
    marginBottom: 4,
  },
  profileCompany: {
    fontSize: 15,
  },
  quickActions: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 20,
  },
  quickActionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
  },
  quickActionText: {
    fontSize: 14,
    fontWeight: '500',
  },
  section: {
    paddingHorizontal: 16,
    paddingVertical: 16,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 16,
  },
  field: {
    marginBottom: 16,
  },
  fieldLabel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  fieldLabelText: {
    fontSize: 13,
    fontWeight: '500',
  },
  required: {
    color: '#EF4444',
    fontSize: 13,
  },
  fieldValue: {
    fontSize: 15,
    paddingVertical: 4,
  },
  linkText: {
    color: '#3B82F6',
  },
  input: {
    fontSize: 15,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  textArea: {
    fontSize: 15,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    minHeight: 100,
  },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#E4E4E7',
  },
  infoLabel: {
    fontSize: 14,
  },
  infoValue: {
    fontSize: 14,
    fontWeight: '500',
  },
  statusBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  statusText: {
    fontSize: 13,
    fontWeight: '500',
  },
});
