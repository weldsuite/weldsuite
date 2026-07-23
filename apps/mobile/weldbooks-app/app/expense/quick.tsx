import { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import {
  ArrowLeft,
  Utensils,
  Car,
  Briefcase,
  Plane,
  Package,
  Zap,
  Shield,
  Tag,
  Calendar,
  Camera,
  X,
} from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import api from '@/services/api';
import type { ExpenseCategory } from '@/types/accounting';

interface CategoryOption {
  key: ExpenseCategory;
  label: string;
  icon: typeof Utensils;
}

const CATEGORIES: CategoryOption[] = [
  { key: 'food', label: 'Food', icon: Utensils },
  { key: 'transport', label: 'Transport', icon: Car },
  { key: 'office', label: 'Office', icon: Briefcase },
  { key: 'travel', label: 'Travel', icon: Plane },
  { key: 'supplies', label: 'Supplies', icon: Package },
  { key: 'utilities', label: 'Utilities', icon: Zap },
  { key: 'insurance', label: 'Insurance', icon: Shield },
  { key: 'other', label: 'Other', icon: Tag },
];

export default function QuickExpenseScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const amountInputRef = useRef<TextInput>(null);
  const params = useLocalSearchParams<{
    amount?: string;
    vendorName?: string;
    date?: string;
    documentId?: string;
  }>();

  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState<ExpenseCategory>('other');
  const [date, setDate] = useState(new Date().toISOString().split('T')[0]);
  const [vendorName, setVendorName] = useState('');
  const [description, setDescription] = useState('');
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Pre-fill from OCR/scan route params
  useEffect(() => {
    if (params.amount) setAmount(params.amount);
    if (params.vendorName) setVendorName(params.vendorName);
    if (params.date) setDate(params.date);
    if (params.documentId) setDocumentId(params.documentId);
  }, []);

  // Focus amount input on mount
  useEffect(() => {
    const timer = setTimeout(() => {
      amountInputRef.current?.focus();
    }, 300);
    return () => clearTimeout(timer);
  }, []);

  const formatDisplayAmount = (value: string): string => {
    if (!value) return '0.00';
    const numeric = value.replace(/[^0-9]/g, '');
    if (!numeric) return '0.00';
    const cents = parseInt(numeric, 10);
    return (cents / 100).toFixed(2);
  };

  const handleAmountChange = (value: string) => {
    // Only allow digits; we treat input as cents
    const digits = value.replace(/[^0-9]/g, '');
    setAmount(digits);
  };

  const getNumericAmount = (): number => {
    if (!amount) return 0;
    return parseInt(amount, 10) / 100;
  };

  const handleCategorySelect = (cat: ExpenseCategory) => {
    setCategory(cat);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const handlePickPhoto = async () => {
    try {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        Alert.alert('Permission needed', 'Camera permission is required to take a photo.');
        return;
      }

      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ['images'],
        quality: 0.8,
        allowsEditing: true,
      });

      if (!result.canceled && result.assets[0]) {
        setPhotoUri(result.assets[0].uri);
      }
    } catch {
      Alert.alert('Error', 'Failed to open camera.');
    }
  };

  const handleRemovePhoto = () => {
    setPhotoUri(null);
  };

  const handleSave = async () => {
    const numericAmount = getNumericAmount();
    if (numericAmount <= 0) {
      Alert.alert('Required', 'Please enter an amount.');
      return;
    }

    try {
      setSaving(true);

      const data = {
        amount: numericAmount,
        category,
        description: description.trim() || undefined,
        vendorName: vendorName.trim() || undefined,
        date,
        documentId: documentId || undefined,
      };

      await api.createQuickExpense(data);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.back();
    } catch {
      Alert.alert('Error', 'Failed to save expense. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const displayAmount = formatDisplayAmount(amount);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View
        style={[
          styles.header,
          { paddingTop: insets.top + 8, backgroundColor: colors.background },
        ]}
      >
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backButton}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <ArrowLeft size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Quick Expense</Text>
        <View style={{ width: 24 }} />
      </View>

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={0}
      >
        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={[styles.scrollContent, { paddingBottom: insets.bottom + 100 }]}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {/* Amount Input — Hero Element */}
          <View style={styles.amountContainer}>
            <Text style={[styles.currencySymbol, { color: colors.muted }]}>EUR</Text>
            <View style={styles.amountRow}>
              <Text style={[styles.currencySign, { color: colors.text }]}>
                {'\u20AC'}
              </Text>
              <Text style={[styles.amountDisplay, { color: colors.text }]}>
                {displayAmount}
              </Text>
            </View>
            <TextInput
              ref={amountInputRef}
              style={styles.hiddenInput}
              value={amount}
              onChangeText={handleAmountChange}
              keyboardType="number-pad"
              caretHidden
            />
          </View>

          {/* Category Selector */}
          <View style={[styles.card, { backgroundColor: colors.cardBackground }]}>
            <Text style={[styles.sectionLabel, { color: colors.muted }]}>Category</Text>
            <View style={styles.categoryGrid}>
              {CATEGORIES.map((cat) => {
                const IconComponent = cat.icon;
                const isSelected = category === cat.key;
                return (
                  <TouchableOpacity
                    key={cat.key}
                    style={[
                      styles.categoryButton,
                      { backgroundColor: colors.background },
                      isSelected && styles.categoryButtonSelected,
                    ]}
                    activeOpacity={0.7}
                    onPress={() => handleCategorySelect(cat.key)}
                  >
                    <IconComponent
                      size={22}
                      color={isSelected ? '#10B981' : colors.muted}
                      strokeWidth={isSelected ? 2.5 : 2}
                    />
                    <Text
                      style={[
                        styles.categoryLabel,
                        { color: isSelected ? '#10B981' : colors.muted },
                        isSelected && styles.categoryLabelSelected,
                      ]}
                    >
                      {cat.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          {/* Date */}
          <View style={[styles.card, { backgroundColor: colors.cardBackground }]}>
            <Text style={[styles.sectionLabel, { color: colors.muted }]}>Date</Text>
            <View style={[styles.dateInputContainer, { borderColor: colors.divider }]}>
              <Calendar size={16} color={colors.muted} />
              <TextInput
                style={[styles.dateInput, { color: colors.text }]}
                value={date}
                onChangeText={setDate}
                placeholder="YYYY-MM-DD"
                placeholderTextColor={colors.muted}
              />
            </View>
          </View>

          {/* Vendor */}
          <View style={[styles.card, { backgroundColor: colors.cardBackground }]}>
            <Text style={[styles.sectionLabel, { color: colors.muted }]}>Vendor</Text>
            <TextInput
              style={[styles.textInput, { color: colors.text, borderColor: colors.divider }]}
              value={vendorName}
              onChangeText={setVendorName}
              placeholder="e.g. Starbucks, Shell, Amazon"
              placeholderTextColor={colors.muted}
            />
          </View>

          {/* Description */}
          <View style={[styles.card, { backgroundColor: colors.cardBackground }]}>
            <Text style={[styles.sectionLabel, { color: colors.muted }]}>Description</Text>
            <TextInput
              style={[styles.textInput, { color: colors.text, borderColor: colors.divider }]}
              value={description}
              onChangeText={setDescription}
              placeholder="What was this expense for?"
              placeholderTextColor={colors.muted}
            />
          </View>

          {/* Photo Attachment */}
          <View style={[styles.card, { backgroundColor: colors.cardBackground }]}>
            <Text style={[styles.sectionLabel, { color: colors.muted }]}>Receipt Photo</Text>
            {photoUri ? (
              <View style={styles.photoContainer}>
                <Image source={{ uri: photoUri }} style={styles.photoThumbnail} />
                <TouchableOpacity style={styles.removePhotoButton} onPress={handleRemovePhoto}>
                  <X size={14} color="#fff" />
                </TouchableOpacity>
              </View>
            ) : (
              <TouchableOpacity
                style={[styles.cameraButton, { borderColor: colors.divider }]}
                activeOpacity={0.7}
                onPress={handlePickPhoto}
              >
                <Camera size={24} color={colors.muted} />
                <Text style={[styles.cameraButtonText, { color: colors.muted }]}>
                  Take a photo of receipt
                </Text>
              </TouchableOpacity>
            )}
          </View>
        </ScrollView>

        {/* Save Button */}
        <View
          style={[
            styles.saveContainer,
            { paddingBottom: insets.bottom + 16, backgroundColor: colors.background, borderTopColor: colors.divider },
          ]}
        >
          <TouchableOpacity
            style={[styles.saveButton, saving && styles.saveButtonDisabled]}
            activeOpacity={0.8}
            onPress={handleSave}
            disabled={saving}
          >
            {saving ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Text style={styles.saveButtonText}>Save Expense</Text>
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  flex: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  backButton: {
    marginRight: 12,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '700',
    flex: 1,
    textAlign: 'center',
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 20,
    paddingTop: 8,
  },
  // Amount Hero
  amountContainer: {
    alignItems: 'center',
    paddingVertical: 32,
    marginBottom: 8,
  },
  currencySymbol: {
    fontSize: 14,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 8,
  },
  amountRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  currencySign: {
    fontSize: 28,
    fontWeight: '300',
    marginTop: 8,
    marginRight: 4,
  },
  amountDisplay: {
    fontSize: 56,
    fontWeight: '700',
    letterSpacing: -2,
    lineHeight: 64,
  },
  hiddenInput: {
    position: 'absolute',
    opacity: 0,
    height: 1,
    width: 1,
  },
  // Cards
  card: {
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
  },
  sectionLabel: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 12,
  },
  // Category Grid
  categoryGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  categoryButton: {
    width: '22.5%',
    aspectRatio: 1,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: 'transparent',
    gap: 4,
  },
  categoryButtonSelected: {
    borderColor: '#10B981',
    backgroundColor: '#F0FDF4',
  },
  categoryLabel: {
    fontSize: 11,
    fontWeight: '500',
    textAlign: 'center',
  },
  categoryLabelSelected: {
    fontWeight: '700',
  },
  // Date
  dateInputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    gap: 8,
  },
  dateInput: {
    flex: 1,
    paddingVertical: 10,
    fontSize: 15,
  },
  // Text inputs
  textInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  // Photo
  cameraButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 24,
    borderWidth: 1,
    borderRadius: 10,
    borderStyle: 'dashed',
    gap: 10,
  },
  cameraButtonText: {
    fontSize: 14,
    fontWeight: '500',
  },
  photoContainer: {
    position: 'relative',
    alignSelf: 'flex-start',
  },
  photoThumbnail: {
    width: 120,
    height: 120,
    borderRadius: 10,
  },
  removePhotoButton: {
    position: 'absolute',
    top: -6,
    right: -6,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#EF4444',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Save
  saveContainer: {
    paddingHorizontal: 20,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  saveButton: {
    backgroundColor: '#10B981',
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveButtonDisabled: {
    opacity: 0.6,
  },
  saveButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
});
