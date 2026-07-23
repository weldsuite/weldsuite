import React, { useState } from 'react';
import {
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  View,
  Text,
  TextInput,
  Switch,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/contexts/ThemeContext';
import { useToast } from '@/contexts/ToastContext';

interface ProductForm {
  title: string;
  description: string;
  price: string;
  compareAtPrice: string;
  sku: string;
  category: string;
  quantityAvailable: string;
  weight: string;
  dimensions: {
    length: string;
    width: string;
    height: string;
  };
  status: 'active' | 'draft';
  trackQuantity: boolean;
  images: string[];
}

export default function NewProductScreen() {
  const { colors } = useTheme();
  const toast = useToast();
  const [form, setForm] = useState<ProductForm>({
    title: '',
    description: '',
    price: '',
    compareAtPrice: '',
    sku: '',
    category: '',
    quantityAvailable: '',
    weight: '',
    dimensions: {
      length: '',
      width: '',
      height: '',
    },
    status: 'active',
    trackQuantity: true,
    images: [],
  });
  const [loading, setLoading] = useState(false);

  const categories = [
    'Electronics',
    'Accessories',
    'Office',
    'Home & Garden',
    'Sports & Outdoors',
    'Books',
    'Clothing',
    'Health & Beauty',
  ];

  const updateForm = (field: keyof ProductForm, value: any) => {
    setForm(prev => ({
      ...prev,
      [field]: value,
    }));
  };

  const updateDimensions = (field: keyof ProductForm['dimensions'], value: string) => {
    setForm(prev => ({
      ...prev,
      dimensions: {
        ...prev.dimensions,
        [field]: value,
      },
    }));
  };

  const validateForm = () => {
    if (!form.title.trim()) {
      toast.error('Product title is required');
      return false;
    }
    if (!form.price.trim()) {
      toast.error('Price is required');
      return false;
    }
    if (isNaN(parseFloat(form.price))) {
      toast.error('Please enter a valid price');
      return false;
    }
    if (!form.sku.trim()) {
      toast.error('SKU is required');
      return false;
    }
    if (!form.category.trim()) {
      toast.error('Category is required');
      return false;
    }
    if (form.trackQuantity && !form.quantityAvailable.trim()) {
      toast.error('Quantity is required when tracking inventory');
      return false;
    }
    if (form.trackQuantity && isNaN(parseInt(form.quantityAvailable))) {
      toast.error('Please enter a valid quantity');
      return false;
    }
    return true;
  };

  const handleSave = async () => {
    if (!validateForm()) return;

    try {
      setLoading(true);

      // Mock API call - replace with actual implementation
      await new Promise(resolve => setTimeout(resolve, 1500));

      toast.success(`Product "${form.title}" has been created successfully!`);
      router.push('/(tabs)/products');
    } catch (error) {
      toast.error('Failed to create product. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const renderSection = (title: string, children: React.ReactNode) => (
    <View style={[styles.section, { backgroundColor: colors.background }]}>
      <Text style={[styles.sectionTitle, { color: colors.text, borderBottomColor: colors.divider }]}>{title}</Text>
      {children}
    </View>
  );

  const renderInput = (
    label: string,
    value: string,
    onChangeText: (text: string) => void,
    options?: {
      placeholder?: string;
      multiline?: boolean;
      keyboardType?: 'default' | 'numeric' | 'email-address';
      required?: boolean;
    }
  ) => (
    <View style={styles.inputGroup}>
      <Text style={[styles.inputLabel, { color: colors.text }]}>
        {label}
        {options?.required && <Text style={[styles.required, { color: colors.text }]}> *</Text>}
      </Text>
      <TextInput
        style={[
          styles.textInput,
          { color: colors.text, borderBottomColor: colors.divider },
          options?.multiline && [styles.textInputMultiline, { borderColor: colors.divider }]
        ]}
        value={value}
        onChangeText={onChangeText}
        placeholder={options?.placeholder}
        placeholderTextColor={colors.muted}
        multiline={options?.multiline}
        keyboardType={options?.keyboardType || 'default'}
      />
    </View>
  );

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { backgroundColor: colors.background, borderBottomColor: colors.divider }]}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => router.back()}
        >
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>New Product</Text>
        <TouchableOpacity
          style={[styles.saveButton, { backgroundColor: colors.text }, loading && styles.saveButtonDisabled]}
          onPress={handleSave}
          disabled={loading}
        >
          <Text style={[styles.saveButtonText, { color: colors.background }]}>
            {loading ? 'Saving...' : 'Save'}
          </Text>
        </TouchableOpacity>
      </View>

      <ScrollView style={styles.content} showsVerticalScrollIndicator={false}>
        {/* Basic Information */}
        {renderSection('Basic Information', (
          <>
            {renderInput(
              'Product Title',
              form.title,
              (text) => updateForm('title', text),
              { placeholder: 'Enter product title', required: true }
            )}

            {renderInput(
              'Description',
              form.description,
              (text) => updateForm('description', text),
              { placeholder: 'Enter product description', multiline: true }
            )}

            <View style={styles.inputGroup}>
              <Text style={[styles.inputLabel, { color: colors.text }]}>Category *</Text>
              <View style={styles.categoryList}>
                {categories.map((category) => (
                  <TouchableOpacity
                    key={category}
                    style={[
                      styles.categoryOption,
                      form.category === category && styles.categoryOptionSelected,
                    ]}
                    onPress={() => updateForm('category', category)}
                  >
                    <Text
                      style={[
                        styles.categoryOptionText,
                        { color: colors.muted },
                        form.category === category && [styles.categoryOptionTextSelected, { color: colors.text }],
                      ]}
                    >
                      {category}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          </>
        ))}

        {/* Pricing */}
        {renderSection('Pricing', (
          <>
            <View style={styles.row}>
              <View style={styles.halfWidth}>
                {renderInput(
                  'Price',
                  form.price,
                  (text) => updateForm('price', text),
                  { placeholder: '0.00', keyboardType: 'numeric', required: true }
                )}
              </View>
              <View style={styles.halfWidth}>
                {renderInput(
                  'Compare at Price',
                  form.compareAtPrice,
                  (text) => updateForm('compareAtPrice', text),
                  { placeholder: '0.00', keyboardType: 'numeric' }
                )}
              </View>
            </View>
          </>
        ))}

        {/* Inventory */}
        {renderSection('Inventory', (
          <>
            {renderInput(
              'SKU',
              form.sku,
              (text) => updateForm('sku', text),
              { placeholder: 'Enter SKU', required: true }
            )}

            <View style={styles.switchRow}>
              <Text style={[styles.switchLabel, { color: colors.text }]}>Track Quantity</Text>
              <Switch
                value={form.trackQuantity}
                onValueChange={(value) => updateForm('trackQuantity', value)}
                trackColor={{ false: colors.divider, true: colors.text }}
                thumbColor={colors.background}
              />
            </View>

            {form.trackQuantity && renderInput(
              'Quantity Available',
              form.quantityAvailable,
              (text) => updateForm('quantityAvailable', text),
              { placeholder: '0', keyboardType: 'numeric', required: true }
            )}
          </>
        ))}

        {/* Shipping */}
        {renderSection('Shipping', (
          <>
            {renderInput(
              'Weight (lbs)',
              form.weight,
              (text) => updateForm('weight', text),
              { placeholder: '0.0', keyboardType: 'numeric' }
            )}

            <Text style={[styles.subSectionTitle, { color: colors.text }]}>Dimensions (inches)</Text>
            <View style={styles.row}>
              <View style={styles.thirdWidth}>
                {renderInput(
                  'Length',
                  form.dimensions.length,
                  (text) => updateDimensions('length', text),
                  { placeholder: '0', keyboardType: 'numeric' }
                )}
              </View>
              <View style={styles.thirdWidth}>
                {renderInput(
                  'Width',
                  form.dimensions.width,
                  (text) => updateDimensions('width', text),
                  { placeholder: '0', keyboardType: 'numeric' }
                )}
              </View>
              <View style={styles.thirdWidth}>
                {renderInput(
                  'Height',
                  form.dimensions.height,
                  (text) => updateDimensions('height', text),
                  { placeholder: '0', keyboardType: 'numeric' }
                )}
              </View>
            </View>
          </>
        ))}

        {/* Status */}
        {renderSection('Status', (
          <View style={styles.statusContainer}>
            <TouchableOpacity
              style={[
                styles.statusButton,
                form.status === 'active' && styles.statusButtonActive,
              ]}
              onPress={() => updateForm('status', 'active')}
            >
              <Text
                style={[
                  styles.statusButtonText,
                  { color: colors.muted },
                  form.status === 'active' && [styles.statusButtonTextActive, { color: colors.text }],
                ]}
              >
                Active
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[
                styles.statusButton,
                form.status === 'draft' && styles.statusButtonActive,
              ]}
              onPress={() => updateForm('status', 'draft')}
            >
              <Text
                style={[
                  styles.statusButtonText,
                  { color: colors.muted },
                  form.status === 'draft' && [styles.statusButtonTextActive, { color: colors.text }],
                ]}
              >
                Draft
              </Text>
            </TouchableOpacity>
          </View>
        ))}

        {/* Images */}
        {renderSection('Images', (
          <TouchableOpacity style={[styles.imageUploadButton, { borderColor: colors.divider }]}>
            <Text style={[styles.imageUploadText, { color: colors.text }]}>Add Product Images</Text>
            <Text style={[styles.imageUploadSubtext, { color: colors.muted }]}>Tap to upload images</Text>
          </TouchableOpacity>
        ))}

        {/* Save Button */}
        <TouchableOpacity
          style={[styles.bottomSaveButton, { backgroundColor: colors.text }, loading && styles.saveButtonDisabled]}
          onPress={handleSave}
          disabled={loading}
        >
          <Text style={[styles.bottomSaveButtonText, { color: colors.background }]}>
            {loading ? 'Creating Product...' : 'Create Product'}
          </Text>
        </TouchableOpacity>

        <View style={styles.bottomSpacer} />
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
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingTop: 24,
    paddingBottom: 16,
    borderBottomWidth: 0.5,
  },
  backButton: {
    padding: 4,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '600',
    letterSpacing: -0.3,
  },
  saveButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
  },
  saveButtonDisabled: {
    opacity: 0.5,
  },
  saveButtonText: {
    fontWeight: '500',
    fontSize: 13,
  },
  content: {
    flex: 1,
  },
  section: {
    marginTop: 0,
    marginHorizontal: 0,
    padding: 24,
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 16,
    paddingBottom: 8,
    borderBottomWidth: 0.5,
  },
  subSectionTitle: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 12,
    marginTop: 8,
  },
  inputGroup: {
    marginBottom: 20,
  },
  inputLabel: {
    fontSize: 13,
    fontWeight: '500',
    marginBottom: 8,
  },
  required: {},
  textInput: {
    borderWidth: 0,
    borderBottomWidth: 0.5,
    paddingHorizontal: 0,
    paddingVertical: 8,
    fontSize: 15,
    backgroundColor: 'transparent',
  },
  textInputMultiline: {
    height: 80,
    textAlignVertical: 'top',
    borderWidth: 0.5,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 6,
  },
  row: {
    flexDirection: 'row',
    gap: 20,
  },
  halfWidth: {
    flex: 1,
  },
  thirdWidth: {
    flex: 1,
  },
  categoryList: {
    gap: 4,
  },
  categoryOption: {
    paddingVertical: 6,
  },
  categoryOptionSelected: {},
  categoryOptionText: {
    fontSize: 15,
    fontWeight: '400',
  },
  categoryOptionTextSelected: {
    fontWeight: '600',
  },
  switchRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  switchLabel: {
    fontSize: 15,
    fontWeight: '500',
  },
  statusContainer: {
    flexDirection: 'row',
    gap: 16,
  },
  statusButton: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
  },
  statusButtonActive: {},
  statusButtonText: {
    fontSize: 15,
    fontWeight: '400',
  },
  statusButtonTextActive: {
    fontWeight: '600',
  },
  imageUploadButton: {
    borderWidth: 0.5,
    borderRadius: 6,
    paddingVertical: 32,
    alignItems: 'center',
  },
  imageUploadText: {
    fontSize: 15,
    fontWeight: '500',
  },
  imageUploadSubtext: {
    fontSize: 13,
    marginTop: 4,
  },
  bottomSaveButton: {
    marginHorizontal: 24,
    marginTop: 24,
    paddingVertical: 14,
    alignItems: 'center',
    borderRadius: 8,
  },
  bottomSaveButtonText: {
    fontSize: 15,
    fontWeight: '600',
  },
  bottomSpacer: {
    height: 32,
  },
});