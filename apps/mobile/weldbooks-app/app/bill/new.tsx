import { useState, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import {
  ArrowLeft,
  Plus,
  Trash2,
  Calendar,
  Paperclip,
  FileText,
} from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import api from '@/services/api';

interface LineItem {
  key: string;
  description: string;
  quantity: string;
  unitPrice: string;
  taxRate: string;
}

function generateKey(): string {
  return Math.random().toString(36).substring(2, 10);
}

function createEmptyLineItem(): LineItem {
  return {
    key: generateKey(),
    description: '',
    quantity: '1',
    unitPrice: '',
    taxRate: '21',
  };
}

export default function NewBillScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{
    vendorName?: string;
    amount?: string;
    date?: string;
    documentId?: string;
    items?: string;
  }>();

  const [vendorName, setVendorName] = useState('');
  const [billNumber, setBillNumber] = useState('');
  const [issueDate, setIssueDate] = useState(new Date().toISOString().split('T')[0]);
  const [dueDate, setDueDate] = useState('');
  const [notes, setNotes] = useState('');
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [lineItems, setLineItems] = useState<LineItem[]>([createEmptyLineItem()]);
  const [saving, setSaving] = useState(false);

  // Pre-fill from OCR/scan route params
  useEffect(() => {
    if (params.vendorName) setVendorName(params.vendorName);
    if (params.date) setIssueDate(params.date);
    if (params.documentId) setDocumentId(params.documentId);

    if (params.items) {
      try {
        const parsed = JSON.parse(params.items);
        if (Array.isArray(parsed) && parsed.length > 0) {
          setLineItems(
            parsed.map((item: any) => ({
              key: generateKey(),
              description: item.description || '',
              quantity: String(item.quantity || 1),
              unitPrice: String(item.unitPrice || ''),
              taxRate: String(item.taxRate || 21),
            }))
          );
        }
      } catch {
        // Ignore parse error
      }
    } else if (params.amount) {
      setLineItems([
        {
          key: generateKey(),
          description: '',
          quantity: '1',
          unitPrice: params.amount,
          taxRate: '21',
        },
      ]);
    }

    // Set default due date 30 days from issue
    if (!params.date) {
      const due = new Date();
      due.setDate(due.getDate() + 30);
      setDueDate(due.toISOString().split('T')[0]);
    } else {
      const due = new Date(params.date);
      due.setDate(due.getDate() + 30);
      setDueDate(due.toISOString().split('T')[0]);
    }
  }, []);

  const updateLineItem = (key: string, field: keyof LineItem, value: string) => {
    setLineItems((prev) =>
      prev.map((item) => (item.key === key ? { ...item, [field]: value } : item))
    );
  };

  const addLineItem = () => {
    setLineItems((prev) => [...prev, createEmptyLineItem()]);
  };

  const removeLineItem = (key: string) => {
    if (lineItems.length <= 1) return;
    setLineItems((prev) => prev.filter((item) => item.key !== key));
  };

  const calculateLineAmount = (item: LineItem): number => {
    const qty = parseFloat(item.quantity) || 0;
    const price = parseFloat(item.unitPrice) || 0;
    return qty * price;
  };

  const calculateSubtotal = (): number => {
    return lineItems.reduce((sum, item) => sum + calculateLineAmount(item), 0);
  };

  const calculateTax = (): number => {
    return lineItems.reduce((sum, item) => {
      const amount = calculateLineAmount(item);
      const rate = parseFloat(item.taxRate) || 0;
      return sum + amount * (rate / 100);
    }, 0);
  };

  const calculateTotal = (): number => {
    return calculateSubtotal() + calculateTax();
  };

  const formatAmount = (amount: number): string => {
    return new Intl.NumberFormat('nl-NL', {
      style: 'currency',
      currency: 'EUR',
      minimumFractionDigits: 2,
    }).format(amount);
  };

  const handleSave = async () => {
    if (!vendorName.trim()) {
      Alert.alert('Required', 'Please enter a vendor name.');
      return;
    }

    const validItems = lineItems.filter(
      (item) => item.description.trim() && parseFloat(item.unitPrice) > 0
    );

    if (validItems.length === 0) {
      Alert.alert('Required', 'Please add at least one line item with a description and price.');
      return;
    }

    try {
      setSaving(true);

      const data = {
        contactName: vendorName.trim(),
        billNumber: billNumber.trim() || undefined,
        issueDate,
        dueDate,
        notes: notes.trim() || undefined,
        documentId: documentId || undefined,
        items: validItems.map((item, index) => ({
          description: item.description.trim(),
          quantity: parseFloat(item.quantity) || 1,
          unitPrice: parseFloat(item.unitPrice) || 0,
          taxRate: parseFloat(item.taxRate) || 0,
          sortOrder: index,
        })),
      };

      await api.createBill(data);
      router.back();
    } catch {
      Alert.alert('Error', 'Failed to create bill. Please try again.');
    } finally {
      setSaving(false);
    }
  };

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
        <Text style={[styles.headerTitle, { color: colors.text }]}>New Bill</Text>
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
          {/* Vendor Name */}
          <View style={[styles.card, { backgroundColor: colors.cardBackground }]}>
            <Text style={[styles.fieldLabel, { color: colors.muted }]}>Vendor Name *</Text>
            <TextInput
              style={[styles.textInput, { color: colors.text, borderColor: colors.divider }]}
              value={vendorName}
              onChangeText={setVendorName}
              placeholder="Enter vendor name"
              placeholderTextColor={colors.muted}
            />
          </View>

          {/* Bill Number */}
          <View style={[styles.card, { backgroundColor: colors.cardBackground }]}>
            <Text style={[styles.fieldLabel, { color: colors.muted }]}>Bill Number</Text>
            <TextInput
              style={[styles.textInput, { color: colors.text, borderColor: colors.divider }]}
              value={billNumber}
              onChangeText={setBillNumber}
              placeholder="Auto-generated if empty"
              placeholderTextColor={colors.muted}
            />
          </View>

          {/* Dates */}
          <View style={[styles.card, { backgroundColor: colors.cardBackground }]}>
            <View style={styles.dateFields}>
              <View style={styles.dateField}>
                <Text style={[styles.fieldLabel, { color: colors.muted }]}>Issue Date</Text>
                <View style={[styles.dateInputContainer, { borderColor: colors.divider }]}>
                  <Calendar size={16} color={colors.muted} />
                  <TextInput
                    style={[styles.dateInput, { color: colors.text }]}
                    value={issueDate}
                    onChangeText={setIssueDate}
                    placeholder="YYYY-MM-DD"
                    placeholderTextColor={colors.muted}
                  />
                </View>
              </View>
              <View style={styles.dateField}>
                <Text style={[styles.fieldLabel, { color: colors.muted }]}>Due Date</Text>
                <View style={[styles.dateInputContainer, { borderColor: colors.divider }]}>
                  <Calendar size={16} color={colors.muted} />
                  <TextInput
                    style={[styles.dateInput, { color: colors.text }]}
                    value={dueDate}
                    onChangeText={setDueDate}
                    placeholder="YYYY-MM-DD"
                    placeholderTextColor={colors.muted}
                  />
                </View>
              </View>
            </View>
          </View>

          {/* Line Items */}
          <View style={[styles.card, { backgroundColor: colors.cardBackground }]}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>Line Items</Text>

            {lineItems.map((item, index) => (
              <View
                key={item.key}
                style={[
                  styles.lineItemCard,
                  { borderColor: colors.divider },
                  index > 0 && { marginTop: 12 },
                ]}
              >
                <View style={styles.lineItemHeader}>
                  <Text style={[styles.lineItemIndex, { color: colors.muted }]}>
                    Item {index + 1}
                  </Text>
                  {lineItems.length > 1 && (
                    <TouchableOpacity
                      onPress={() => removeLineItem(item.key)}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    >
                      <Trash2 size={16} color="#EF4444" />
                    </TouchableOpacity>
                  )}
                </View>

                <TextInput
                  style={[styles.textInput, { color: colors.text, borderColor: colors.divider }]}
                  value={item.description}
                  onChangeText={(val) => updateLineItem(item.key, 'description', val)}
                  placeholder="Description"
                  placeholderTextColor={colors.muted}
                />

                <View style={styles.lineItemRow}>
                  <View style={styles.lineItemField}>
                    <Text style={[styles.miniLabel, { color: colors.muted }]}>Qty</Text>
                    <TextInput
                      style={[
                        styles.textInput,
                        styles.smallInput,
                        { color: colors.text, borderColor: colors.divider },
                      ]}
                      value={item.quantity}
                      onChangeText={(val) => updateLineItem(item.key, 'quantity', val)}
                      keyboardType="decimal-pad"
                      placeholder="1"
                      placeholderTextColor={colors.muted}
                    />
                  </View>
                  <View style={styles.lineItemField}>
                    <Text style={[styles.miniLabel, { color: colors.muted }]}>Unit Price</Text>
                    <TextInput
                      style={[
                        styles.textInput,
                        styles.smallInput,
                        { color: colors.text, borderColor: colors.divider },
                      ]}
                      value={item.unitPrice}
                      onChangeText={(val) => updateLineItem(item.key, 'unitPrice', val)}
                      keyboardType="decimal-pad"
                      placeholder="0.00"
                      placeholderTextColor={colors.muted}
                    />
                  </View>
                  <View style={styles.lineItemField}>
                    <Text style={[styles.miniLabel, { color: colors.muted }]}>Tax %</Text>
                    <TextInput
                      style={[
                        styles.textInput,
                        styles.smallInput,
                        { color: colors.text, borderColor: colors.divider },
                      ]}
                      value={item.taxRate}
                      onChangeText={(val) => updateLineItem(item.key, 'taxRate', val)}
                      keyboardType="decimal-pad"
                      placeholder="21"
                      placeholderTextColor={colors.muted}
                    />
                  </View>
                </View>

                <Text style={[styles.lineTotal, { color: colors.text }]}>
                  {formatAmount(calculateLineAmount(item))}
                </Text>
              </View>
            ))}

            <TouchableOpacity style={styles.addLineButton} activeOpacity={0.7} onPress={addLineItem}>
              <Plus size={16} color="#10B981" />
              <Text style={styles.addLineText}>Add Line Item</Text>
            </TouchableOpacity>
          </View>

          {/* Totals */}
          <View style={[styles.card, { backgroundColor: colors.cardBackground }]}>
            <View style={styles.totalRow}>
              <Text style={[styles.totalLabel, { color: colors.muted }]}>Subtotal</Text>
              <Text style={[styles.totalValue, { color: colors.text }]}>
                {formatAmount(calculateSubtotal())}
              </Text>
            </View>
            <View style={styles.totalRow}>
              <Text style={[styles.totalLabel, { color: colors.muted }]}>Tax</Text>
              <Text style={[styles.totalValue, { color: colors.text }]}>
                {formatAmount(calculateTax())}
              </Text>
            </View>
            <View style={[styles.totalDivider, { backgroundColor: colors.divider }]} />
            <View style={styles.totalRow}>
              <Text style={[styles.totalLabelBold, { color: colors.text }]}>Total</Text>
              <Text style={[styles.totalValueBold, { color: colors.text }]}>
                {formatAmount(calculateTotal())}
              </Text>
            </View>
          </View>

          {/* Notes */}
          <View style={[styles.card, { backgroundColor: colors.cardBackground }]}>
            <Text style={[styles.fieldLabel, { color: colors.muted }]}>Notes</Text>
            <TextInput
              style={[
                styles.textInput,
                styles.notesInput,
                { color: colors.text, borderColor: colors.divider },
              ]}
              value={notes}
              onChangeText={setNotes}
              placeholder="Add notes..."
              placeholderTextColor={colors.muted}
              multiline
              textAlignVertical="top"
            />
          </View>

          {/* Document Attachment */}
          <View style={[styles.card, { backgroundColor: colors.cardBackground }]}>
            {documentId ? (
              <View style={styles.attachedDoc}>
                <FileText size={20} color="#10B981" />
                <Text style={[styles.attachedDocText, { color: colors.text }]}>
                  Document attached
                </Text>
                <TouchableOpacity onPress={() => setDocumentId(null)}>
                  <Text style={styles.removeDocText}>Remove</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <TouchableOpacity style={styles.attachButton} activeOpacity={0.7}>
                <Paperclip size={18} color={colors.muted} />
                <Text style={[styles.attachButtonText, { color: colors.muted }]}>
                  Attach document or receipt
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
              <Text style={styles.saveButtonText}>Save Bill</Text>
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
  card: {
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
  },
  fieldLabel: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 12,
  },
  textInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  dateFields: {
    flexDirection: 'row',
    gap: 12,
  },
  dateField: {
    flex: 1,
  },
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
  lineItemCard: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
  },
  lineItemHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  lineItemIndex: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  lineItemRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 8,
  },
  lineItemField: {
    flex: 1,
  },
  miniLabel: {
    fontSize: 11,
    fontWeight: '500',
    marginBottom: 4,
  },
  smallInput: {
    textAlign: 'center',
  },
  lineTotal: {
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'right',
    marginTop: 8,
  },
  addLineButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    marginTop: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#10B981',
    borderStyle: 'dashed',
    gap: 6,
  },
  addLineText: {
    color: '#10B981',
    fontSize: 14,
    fontWeight: '600',
  },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 4,
  },
  totalLabel: {
    fontSize: 14,
  },
  totalValue: {
    fontSize: 14,
    fontWeight: '500',
  },
  totalLabelBold: {
    fontSize: 16,
    fontWeight: '700',
  },
  totalValueBold: {
    fontSize: 16,
    fontWeight: '700',
  },
  totalDivider: {
    height: 1,
    marginVertical: 8,
  },
  notesInput: {
    height: 80,
  },
  attachButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 16,
    gap: 8,
  },
  attachButtonText: {
    fontSize: 14,
    fontWeight: '500',
  },
  attachedDoc: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  attachedDocText: {
    fontSize: 14,
    fontWeight: '500',
    flex: 1,
  },
  removeDocText: {
    color: '#EF4444',
    fontSize: 13,
    fontWeight: '600',
  },
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
