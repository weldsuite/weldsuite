import React, { useState } from 'react';
import {
  StyleSheet,
  ScrollView,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useTheme } from '@/contexts/ThemeContext';
import { useToast } from '@/contexts/ToastContext';
import { ChevronLeft } from 'lucide-react-native';

interface ParcelFormData {
  trackingNumber: string;
  recipient: string;
  recipientEmail: string;
  recipientPhone: string;
  sender: string;
  senderEmail: string;
  senderPhone: string;
  weight: string;
  length: string;
  width: string;
  height: string;
  description: string;
  value: string;
  shippingAddress: {
    street: string;
    city: string;
    state: string;
    zipCode: string;
    country: string;
  };
  pickupAddress: {
    street: string;
    city: string;
    state: string;
    zipCode: string;
    country: string;
  };
  serviceType: 'standard' | 'express' | 'overnight' | 'economy';
  requiresSignature: boolean;
  insurance: boolean;
  fragile: boolean;
}

export default function AddParcelScreen() {
  const { colors } = useTheme();
  const toast = useToast();
  const [formData, setFormData] = useState<ParcelFormData>({
    trackingNumber: '',
    recipient: '',
    recipientEmail: '',
    recipientPhone: '',
    sender: '',
    senderEmail: '',
    senderPhone: '',
    weight: '',
    length: '',
    width: '',
    height: '',
    description: '',
    value: '',
    shippingAddress: {
      street: '',
      city: '',
      state: '',
      zipCode: '',
      country: 'Netherlands',
    },
    pickupAddress: {
      street: '',
      city: '',
      state: '',
      zipCode: '',
      country: 'Netherlands',
    },
    serviceType: 'standard',
    requiresSignature: false,
    insurance: false,
    fragile: false,
  });

  const generateTrackingNumber = () => {
    const prefix = 'PKG';
    const year = new Date().getFullYear();
    const random = Math.floor(Math.random() * 1000000).toString().padStart(6, '0');
    return `${prefix}${year}${random}`;
  };

  useState(() => {
    // Generate tracking number on mount
    setFormData(prev => ({ ...prev, trackingNumber: generateTrackingNumber() }));
  });

  const handleSubmit = () => {
    // Validate required fields
    if (!formData.recipient || !formData.sender || !formData.weight) {
      toast.error('Please fill in all required fields');
      return;
    }

    // Mock save - in real app, would call API
    toast.success(`Parcel ${formData.trackingNumber} has been created successfully`);
    router.back();
  };

  const updateFormData = (field: string, value: any) => {
    if (field.includes('.')) {
      const [parent, child] = field.split('.');
      setFormData(prev => ({
        ...prev,
        [parent]: {
          ...(prev as any)[parent],
          [child]: value,
        },
      }));
    } else {
      setFormData(prev => ({ ...prev, [field]: value }));
    }
  };

  const ServiceTypeButton = ({ type, label }: { type: string; label: string }) => (
    <TouchableOpacity
      style={[
        styles.serviceTypeButton,
        {
          backgroundColor: formData.serviceType === type ? colors.text : colors.background,
          borderColor: formData.serviceType === type ? colors.text : colors.buttonBorder,
        },
      ]}
      onPress={() => updateFormData('serviceType', type)}
    >
      <Text
        style={[
          styles.serviceTypeText,
          { color: formData.serviceType === type ? colors.background : colors.text },
        ]}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );

  const CheckboxOption = ({ field, label }: { field: string; label: string }) => (
    <TouchableOpacity
      style={styles.checkboxContainer}
      onPress={() => updateFormData(field, !(formData as any)[field])}
    >
      <View
        style={[
          styles.checkbox,
          {
            backgroundColor: (formData as any)[field] ? colors.text : colors.background,
            borderColor: (formData as any)[field] ? colors.text : colors.buttonBorder,
          },
        ]}
      >
        {(formData as any)[field] && (
          <Ionicons name="checkmark" size={14} color={colors.background} />
        )}
      </View>
      <Text style={[styles.checkboxLabel, { color: colors.text }]}>{label}</Text>
    </TouchableOpacity>
  );

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: colors.background }]}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      {/* Header */}
      <View style={[styles.header, { backgroundColor: colors.background, borderBottomColor: colors.divider }]}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backButton}
        >
          <ChevronLeft size={24} color={colors.text} strokeWidth={2} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>New Parcel</Text>
        <View style={{ width: 32 }} />
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
      >
        {/* Tracking Number */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>Tracking Information</Text>
          <View style={styles.inputGroup}>
            <Text style={[styles.label, { color: colors.text }]}>Tracking Number</Text>
            <View style={[styles.readOnlyInput, { backgroundColor: '#F3F4F6' }]}>
              <Text style={[styles.readOnlyText, { color: colors.text }]}>{formData.trackingNumber}</Text>
              <TouchableOpacity onPress={() => updateFormData('trackingNumber', generateTrackingNumber())}>
                <Ionicons name="refresh" size={18} color={colors.muted} />
              </TouchableOpacity>
            </View>
          </View>
        </View>

        {/* Sender Information */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>Sender Information</Text>
          
          <View style={styles.inputGroup}>
            <Text style={[styles.label, { color: colors.text }]}>
              Sender Name <Text style={{ color: '#EF4444' }}>*</Text>
            </Text>
            <TextInput
              style={[styles.input, { color: colors.text, borderColor: colors.divider }]}
              value={formData.sender}
              onChangeText={(value) => updateFormData('sender', value)}
              placeholder="Enter sender name"
              placeholderTextColor={colors.muted}
            />
          </View>

          <View style={styles.row}>
            <View style={[styles.inputGroup, { flex: 1 }]}>
              <Text style={[styles.label, { color: colors.text }]}>Email</Text>
              <TextInput
                style={[styles.input, { color: colors.text, borderColor: colors.divider }]}
                value={formData.senderEmail}
                onChangeText={(value) => updateFormData('senderEmail', value)}
                placeholder="sender@example.com"
                placeholderTextColor={colors.muted}
                keyboardType="email-address"
                autoCapitalize="none"
              />
            </View>

            <View style={[styles.inputGroup, { flex: 1 }]}>
              <Text style={[styles.label, { color: colors.text }]}>Phone</Text>
              <TextInput
                style={[styles.input, { color: colors.text, borderColor: colors.divider }]}
                value={formData.senderPhone}
                onChangeText={(value) => updateFormData('senderPhone', value)}
                placeholder="+31 6 12345678"
                placeholderTextColor={colors.muted}
                keyboardType="phone-pad"
              />
            </View>
          </View>
        </View>

        {/* Pickup Address */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>Pickup Address</Text>
          
          <View style={styles.inputGroup}>
            <Text style={[styles.label, { color: colors.text }]}>Street Address</Text>
            <TextInput
              style={[styles.input, { color: colors.text, borderColor: colors.divider }]}
              value={formData.pickupAddress.street}
              onChangeText={(value) => updateFormData('pickupAddress.street', value)}
              placeholder="123 Main Street"
              placeholderTextColor={colors.muted}
            />
          </View>

          <View style={styles.row}>
            <View style={[styles.inputGroup, { flex: 2 }]}>
              <Text style={[styles.label, { color: colors.text }]}>City</Text>
              <TextInput
                style={[styles.input, { color: colors.text, borderColor: colors.divider }]}
                value={formData.pickupAddress.city}
                onChangeText={(value) => updateFormData('pickupAddress.city', value)}
                placeholder="Amsterdam"
                placeholderTextColor={colors.muted}
              />
            </View>

            <View style={[styles.inputGroup, { flex: 1 }]}>
              <Text style={[styles.label, { color: colors.text }]}>Postal Code</Text>
              <TextInput
                style={[styles.input, { color: colors.text, borderColor: colors.divider }]}
                value={formData.pickupAddress.zipCode}
                onChangeText={(value) => updateFormData('pickupAddress.zipCode', value)}
                placeholder="1012"
                placeholderTextColor={colors.muted}
              />
            </View>
          </View>
        </View>

        {/* Recipient Information */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>Recipient Information</Text>
          
          <View style={styles.inputGroup}>
            <Text style={[styles.label, { color: colors.text }]}>
              Recipient Name <Text style={{ color: '#EF4444' }}>*</Text>
            </Text>
            <TextInput
              style={[styles.input, { color: colors.text, borderColor: colors.divider }]}
              value={formData.recipient}
              onChangeText={(value) => updateFormData('recipient', value)}
              placeholder="Enter recipient name"
              placeholderTextColor={colors.muted}
            />
          </View>

          <View style={styles.row}>
            <View style={[styles.inputGroup, { flex: 1 }]}>
              <Text style={[styles.label, { color: colors.text }]}>Email</Text>
              <TextInput
                style={[styles.input, { color: colors.text, borderColor: colors.divider }]}
                value={formData.recipientEmail}
                onChangeText={(value) => updateFormData('recipientEmail', value)}
                placeholder="recipient@example.com"
                placeholderTextColor={colors.muted}
                keyboardType="email-address"
                autoCapitalize="none"
              />
            </View>

            <View style={[styles.inputGroup, { flex: 1 }]}>
              <Text style={[styles.label, { color: colors.text }]}>Phone</Text>
              <TextInput
                style={[styles.input, { color: colors.text, borderColor: colors.divider }]}
                value={formData.recipientPhone}
                onChangeText={(value) => updateFormData('recipientPhone', value)}
                placeholder="+31 6 12345678"
                placeholderTextColor={colors.muted}
                keyboardType="phone-pad"
              />
            </View>
          </View>
        </View>

        {/* Shipping Address */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>Shipping Address</Text>
          
          <View style={styles.inputGroup}>
            <Text style={[styles.label, { color: colors.text }]}>Street Address</Text>
            <TextInput
              style={[styles.input, { color: colors.text, borderColor: colors.divider }]}
              value={formData.shippingAddress.street}
              onChangeText={(value) => updateFormData('shippingAddress.street', value)}
              placeholder="456 Oak Avenue"
              placeholderTextColor={colors.muted}
            />
          </View>

          <View style={styles.row}>
            <View style={[styles.inputGroup, { flex: 2 }]}>
              <Text style={[styles.label, { color: colors.text }]}>City</Text>
              <TextInput
                style={[styles.input, { color: colors.text, borderColor: colors.divider }]}
                value={formData.shippingAddress.city}
                onChangeText={(value) => updateFormData('shippingAddress.city', value)}
                placeholder="Rotterdam"
                placeholderTextColor={colors.muted}
              />
            </View>

            <View style={[styles.inputGroup, { flex: 1 }]}>
              <Text style={[styles.label, { color: colors.text }]}>Postal Code</Text>
              <TextInput
                style={[styles.input, { color: colors.text, borderColor: colors.divider }]}
                value={formData.shippingAddress.zipCode}
                onChangeText={(value) => updateFormData('shippingAddress.zipCode', value)}
                placeholder="3011"
                placeholderTextColor={colors.muted}
              />
            </View>
          </View>
        </View>

        {/* Package Details */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>Package Details</Text>
          
          <View style={styles.inputGroup}>
            <Text style={[styles.label, { color: colors.text }]}>Description</Text>
            <TextInput
              style={[styles.input, { color: colors.text, borderColor: colors.divider }]}
              value={formData.description}
              onChangeText={(value) => updateFormData('description', value)}
              placeholder="Electronics, Documents, etc."
              placeholderTextColor={colors.muted}
            />
          </View>

          <View style={styles.row}>
            <View style={[styles.inputGroup, { flex: 1 }]}>
              <Text style={[styles.label, { color: colors.text }]}>
                Weight (kg) <Text style={{ color: '#EF4444' }}>*</Text>
              </Text>
              <TextInput
                style={[styles.input, { color: colors.text, borderColor: colors.divider }]}
                value={formData.weight}
                onChangeText={(value) => updateFormData('weight', value)}
                placeholder="2.5"
                placeholderTextColor={colors.muted}
                keyboardType="decimal-pad"
              />
            </View>

            <View style={[styles.inputGroup, { flex: 1 }]}>
              <Text style={[styles.label, { color: colors.text }]}>Value (€)</Text>
              <TextInput
                style={[styles.input, { color: colors.text, borderColor: colors.divider }]}
                value={formData.value}
                onChangeText={(value) => updateFormData('value', value)}
                placeholder="100.00"
                placeholderTextColor={colors.muted}
                keyboardType="decimal-pad"
              />
            </View>
          </View>

          <Text style={[styles.label, { color: colors.text, marginBottom: 8 }]}>Dimensions (cm)</Text>
          <View style={styles.row}>
            <View style={[styles.inputGroup, { flex: 1 }]}>
              <TextInput
                style={[styles.input, { color: colors.text, borderColor: colors.divider }]}
                value={formData.length}
                onChangeText={(value) => updateFormData('length', value)}
                placeholder="Length"
                placeholderTextColor={colors.muted}
                keyboardType="decimal-pad"
              />
            </View>

            <View style={[styles.inputGroup, { flex: 1 }]}>
              <TextInput
                style={[styles.input, { color: colors.text, borderColor: colors.divider }]}
                value={formData.width}
                onChangeText={(value) => updateFormData('width', value)}
                placeholder="Width"
                placeholderTextColor={colors.muted}
                keyboardType="decimal-pad"
              />
            </View>

            <View style={[styles.inputGroup, { flex: 1 }]}>
              <TextInput
                style={[styles.input, { color: colors.text, borderColor: colors.divider }]}
                value={formData.height}
                onChangeText={(value) => updateFormData('height', value)}
                placeholder="Height"
                placeholderTextColor={colors.muted}
                keyboardType="decimal-pad"
              />
            </View>
          </View>
        </View>

        {/* Service Type */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>Service Type</Text>
          <View style={styles.serviceTypeContainer}>
            <ServiceTypeButton type="economy" label="Economy" />
            <ServiceTypeButton type="standard" label="Standard" />
            <ServiceTypeButton type="express" label="Express" />
            <ServiceTypeButton type="overnight" label="Overnight" />
          </View>
        </View>

        {/* Additional Options */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>Additional Options</Text>
          <View style={styles.optionsContainer}>
            <CheckboxOption field="requiresSignature" label="Requires Signature" />
            <CheckboxOption field="insurance" label="Add Insurance" />
            <CheckboxOption field="fragile" label="Fragile Package" />
          </View>
        </View>

        {/* Action Buttons */}
        <View style={styles.buttonContainer}>
          <TouchableOpacity
            style={[styles.button, styles.cancelButton, { borderColor: colors.buttonBorder }]}
            onPress={() => router.back()}
          >
            <Text style={[styles.cancelButtonText, { color: colors.text }]}>Cancel</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.button, styles.submitButton, { backgroundColor: colors.text }]}
            onPress={handleSubmit}
          >
            <Text style={[styles.submitButtonText, { color: colors.background }]}>Create Parcel</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 60,
    paddingBottom: 16,
    borderBottomWidth: 0.5,
  },
  backButton: {
    padding: 8,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '600',
  },
  scrollContent: {
    paddingVertical: 20,
  },
  section: {
    paddingHorizontal: 24,
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 16,
  },
  inputGroup: {
    marginBottom: 16,
  },
  label: {
    fontSize: 13,
    fontWeight: '500',
    marginBottom: 8,
  },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
  },
  readOnlyInput: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  readOnlyText: {
    fontSize: 14,
    fontWeight: '500',
  },
  row: {
    flexDirection: 'row',
    gap: 12,
  },
  serviceTypeContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  serviceTypeButton: {
    flex: 1,
    minWidth: '45%',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
  },
  serviceTypeText: {
    fontSize: 13,
    fontWeight: '500',
  },
  optionsContainer: {
    gap: 12,
  },
  checkboxContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 4,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxLabel: {
    fontSize: 14,
  },
  buttonContainer: {
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 24,
    paddingTop: 20,
    paddingBottom: 40,
  },
  button: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
  },
  cancelButton: {
    borderWidth: 1,
  },
  cancelButtonText: {
    fontSize: 14,
    fontWeight: '600',
  },
  submitButton: {},
  submitButtonText: {
    fontSize: 14,
    fontWeight: '600',
  },
});