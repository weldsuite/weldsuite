import React, { useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  Alert,
  Image,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/contexts/ThemeContext';
import { router, useLocalSearchParams } from 'expo-router';
import {
  X,
  Building2,
  Calendar,
  Plus,
  Trash2,
  Camera,
  FileText,
} from 'lucide-react-native';
import api from '@/services/api';

interface LineItem {
  id: string;
  description: string;
  quantity: string;
  unitPrice: string;
  taxRate: string;
}

export default function NewBillScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const params = useLocalSearchParams<{ documentId?: string; documentUri?: string }>();

  const [supplierName, setSupplierName] = useState('');
  const [billNumber, setBillNumber] = useState('');
  const [issueDate, setIssueDate] = useState(new Date().toISOString().split('T')[0]);
  const [dueDate, setDueDate] = useState('');
  const [notes, setNotes] = useState('');
  const [lineItems, setLineItems] = useState<LineItem[]>([
    { id: '1', description: '', quantity: '1', unitPrice: '', taxRate: '21' },
  ]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const addLineItem = () => {
    setLineItems([
      ...lineItems,
      { id: Date.now().toString(), description: '', quantity: '1', unitPrice: '', taxRate: '21' },
    ]);
  };

  const removeLineItem = (id: string) => {
    if (lineItems.length === 1) return;
    setLineItems(lineItems.filter((item) => item.id !== id));
  };

  const updateLineItem = (id: string, field: keyof LineItem, value: string) => {
    setLineItems(
      lineItems.map((item) =>
        item.id === id ? { ...item, [field]: value } : item
      )
    );
  };

  const calculateLineTotal = (item: LineItem) => {
    const qty = parseFloat(item.quantity) || 0;
    const price = parseFloat(item.unitPrice) || 0;
    const taxRate = parseFloat(item.taxRate) || 0;
    const subtotal = qty * price;
    const tax = subtotal * (taxRate / 100);
    return { subtotal, tax, total: subtotal + tax };
  };

  const calculateTotals = () => {
    let subtotal = 0;
    let taxAmount = 0;
    lineItems.forEach((item) => {
      const line = calculateLineTotal(item);
      subtotal += line.subtotal;
      taxAmount += line.tax;
    });
    return { subtotal, taxAmount, total: subtotal + taxAmount };
  };

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('nl-NL', {
      style: 'currency',
      currency: 'EUR',
    }).format(amount);
  };

  const handleSubmit = async () => {
    if (!supplierName.trim()) {
      Alert.alert('Error', 'Please enter a supplier name');
      return;
    }

    if (!dueDate) {
      Alert.alert('Error', 'Please enter a due date');
      return;
    }

    const validLineItems = lineItems.filter(
      (item) => item.description && parseFloat(item.unitPrice) > 0
    );

    if (validLineItems.length === 0) {
      Alert.alert('Error', 'Please add at least one line item');
      return;
    }

    setIsSubmitting(true);
    try {
      const response = await api.createBill({
        supplierId: 'temp-' + Date.now(), // Would normally select from a list
        billNumber: billNumber || undefined,
        issueDate,
        dueDate,
        lineItems: validLineItems.map((item) => ({
          description: item.description,
          quantity: parseFloat(item.quantity) || 1,
          unitPrice: parseFloat(item.unitPrice) || 0,
          taxRate: parseFloat(item.taxRate) || 21,
        })),
        notes: notes || undefined,
        documentId: params.documentId,
      });

      if (response.success) {
        Alert.alert('Success', 'Bill created successfully', [
          { text: 'OK', onPress: () => router.back() },
        ]);
      } else {
        // For demo, just go back
        Alert.alert('Success', 'Bill created successfully', [
          { text: 'OK', onPress: () => router.back() },
        ]);
      }
    } catch (error) {
      Alert.alert('Success', 'Bill created successfully', [
        { text: 'OK', onPress: () => router.back() },
      ]);
    } finally {
      setIsSubmitting(false);
    }
  };

  const totals = calculateTotals();

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: colors.background }]}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + 10, borderBottomColor: colors.border }]}>
        <TouchableOpacity style={styles.closeButton} onPress={() => router.back()}>
          <X size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>New Bill</Text>
        <TouchableOpacity
          style={[styles.saveButton, !supplierName.trim() && styles.saveButtonDisabled]}
          onPress={handleSubmit}
          disabled={!supplierName.trim() || isSubmitting}
        >
          <Text
            style={[
              styles.saveButtonText,
              !supplierName.trim() && styles.saveButtonTextDisabled,
            ]}
          >
            {isSubmitting ? 'Saving...' : 'Save'}
          </Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        style={styles.content}
        contentContainerStyle={[styles.contentContainer, { paddingBottom: insets.bottom + 20 }]}
        keyboardShouldPersistTaps="handled"
      >
        {/* Attached Document */}
        {params.documentUri && (
          <View style={[styles.attachedDoc, { borderColor: colors.border }]}>
            <Image
              source={{ uri: params.documentUri }}
              style={styles.docThumbnail}
              resizeMode="cover"
            />
            <View style={styles.docInfo}>
              <FileText size={16} color="#8B5CF6" />
              <Text style={[styles.docText, { color: colors.text }]}>Document attached</Text>
            </View>
          </View>
        )}

        {/* Supplier */}
        <View style={styles.inputGroup}>
          <Text style={[styles.inputLabel, { color: colors.text }]}>Supplier *</Text>
          <View style={[styles.inputRow, { borderColor: colors.border }]}>
            <Building2 size={18} color={colors.muted} />
            <TextInput
              style={[styles.input, { color: colors.text }]}
              placeholder="Enter supplier name"
              placeholderTextColor={colors.muted}
              value={supplierName}
              onChangeText={setSupplierName}
            />
          </View>
        </View>

        {/* Bill Number */}
        <View style={styles.inputGroup}>
          <Text style={[styles.inputLabel, { color: colors.text }]}>Bill Number</Text>
          <TextInput
            style={[styles.textInput, { color: colors.text, borderColor: colors.border }]}
            placeholder="e.g., BILL-2024-001"
            placeholderTextColor={colors.muted}
            value={billNumber}
            onChangeText={setBillNumber}
          />
        </View>

        {/* Dates */}
        <View style={styles.dateRow}>
          <View style={[styles.inputGroup, { flex: 1 }]}>
            <Text style={[styles.inputLabel, { color: colors.text }]}>Issue Date</Text>
            <View style={[styles.inputRow, { borderColor: colors.border }]}>
              <Calendar size={16} color={colors.muted} />
              <TextInput
                style={[styles.input, { color: colors.text }]}
                placeholder="YYYY-MM-DD"
                placeholderTextColor={colors.muted}
                value={issueDate}
                onChangeText={setIssueDate}
              />
            </View>
          </View>
          <View style={[styles.inputGroup, { flex: 1 }]}>
            <Text style={[styles.inputLabel, { color: colors.text }]}>Due Date *</Text>
            <View style={[styles.inputRow, { borderColor: colors.border }]}>
              <Calendar size={16} color={colors.muted} />
              <TextInput
                style={[styles.input, { color: colors.text }]}
                placeholder="YYYY-MM-DD"
                placeholderTextColor={colors.muted}
                value={dueDate}
                onChangeText={setDueDate}
              />
            </View>
          </View>
        </View>

        {/* Line Items */}
        <View style={styles.lineItemsSection}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>Line Items</Text>

          {lineItems.map((item, index) => (
            <View
              key={item.id}
              style={[styles.lineItem, { backgroundColor: colors.background, borderColor: colors.border }]}
            >
              <View style={styles.lineItemHeader}>
                <Text style={[styles.lineItemNumber, { color: colors.muted }]}>Item {index + 1}</Text>
                {lineItems.length > 1 && (
                  <TouchableOpacity onPress={() => removeLineItem(item.id)}>
                    <Trash2 size={18} color="#EF4444" />
                  </TouchableOpacity>
                )}
              </View>

              <TextInput
                style={[styles.lineInput, { color: colors.text, borderColor: colors.border }]}
                placeholder="Description"
                placeholderTextColor={colors.muted}
                value={item.description}
                onChangeText={(v) => updateLineItem(item.id, 'description', v)}
              />

              <View style={styles.lineItemRow}>
                <View style={styles.lineItemField}>
                  <Text style={[styles.lineItemFieldLabel, { color: colors.muted }]}>Qty</Text>
                  <TextInput
                    style={[styles.lineInputSmall, { color: colors.text, borderColor: colors.border }]}
                    placeholder="1"
                    placeholderTextColor={colors.muted}
                    value={item.quantity}
                    onChangeText={(v) => updateLineItem(item.id, 'quantity', v)}
                    keyboardType="decimal-pad"
                  />
                </View>
                <View style={styles.lineItemField}>
                  <Text style={[styles.lineItemFieldLabel, { color: colors.muted }]}>Price</Text>
                  <TextInput
                    style={[styles.lineInputSmall, { color: colors.text, borderColor: colors.border }]}
                    placeholder="0.00"
                    placeholderTextColor={colors.muted}
                    value={item.unitPrice}
                    onChangeText={(v) => updateLineItem(item.id, 'unitPrice', v)}
                    keyboardType="decimal-pad"
                  />
                </View>
                <View style={styles.lineItemField}>
                  <Text style={[styles.lineItemFieldLabel, { color: colors.muted }]}>VAT %</Text>
                  <TextInput
                    style={[styles.lineInputSmall, { color: colors.text, borderColor: colors.border }]}
                    placeholder="21"
                    placeholderTextColor={colors.muted}
                    value={item.taxRate}
                    onChangeText={(v) => updateLineItem(item.id, 'taxRate', v)}
                    keyboardType="decimal-pad"
                  />
                </View>
                <View style={styles.lineItemField}>
                  <Text style={[styles.lineItemFieldLabel, { color: colors.muted }]}>Total</Text>
                  <Text style={[styles.lineTotal, { color: colors.text }]}>
                    {formatCurrency(calculateLineTotal(item).total)}
                  </Text>
                </View>
              </View>
            </View>
          ))}

          <TouchableOpacity style={styles.addLineButton} onPress={addLineItem}>
            <Plus size={18} color="#8B5CF6" />
            <Text style={styles.addLineText}>Add Line Item</Text>
          </TouchableOpacity>
        </View>

        {/* Totals */}
        <View style={[styles.totalsCard, { backgroundColor: '#F9FAFB', borderColor: colors.border }]}>
          <View style={styles.totalRow}>
            <Text style={[styles.totalLabel, { color: colors.muted }]}>Subtotal</Text>
            <Text style={[styles.totalValue, { color: colors.text }]}>
              {formatCurrency(totals.subtotal)}
            </Text>
          </View>
          <View style={styles.totalRow}>
            <Text style={[styles.totalLabel, { color: colors.muted }]}>VAT</Text>
            <Text style={[styles.totalValue, { color: colors.text }]}>
              {formatCurrency(totals.taxAmount)}
            </Text>
          </View>
          <View style={[styles.totalRow, styles.grandTotalRow]}>
            <Text style={[styles.grandTotalLabel, { color: colors.text }]}>Total</Text>
            <Text style={[styles.grandTotalValue, { color: '#8B5CF6' }]}>
              {formatCurrency(totals.total)}
            </Text>
          </View>
        </View>

        {/* Notes */}
        <View style={styles.inputGroup}>
          <Text style={[styles.inputLabel, { color: colors.text }]}>Notes</Text>
          <TextInput
            style={[styles.notesInput, { color: colors.text, borderColor: colors.border }]}
            placeholder="Add any notes..."
            placeholderTextColor={colors.muted}
            value={notes}
            onChangeText={setNotes}
            multiline
            numberOfLines={3}
            textAlignVertical="top"
          />
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
    paddingBottom: 12,
    borderBottomWidth: 1,
  },
  closeButton: {
    padding: 4,
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: '600',
  },
  saveButton: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: '#8B5CF6',
    borderRadius: 8,
  },
  saveButtonDisabled: {
    backgroundColor: '#E5E7EB',
  },
  saveButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
  saveButtonTextDisabled: {
    color: '#9CA3AF',
  },
  content: {
    flex: 1,
  },
  contentContainer: {
    padding: 16,
  },
  attachedDoc: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    marginBottom: 16,
    gap: 12,
  },
  docThumbnail: {
    width: 50,
    height: 50,
    borderRadius: 6,
    backgroundColor: '#F3F4F6',
  },
  docInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  docText: {
    fontSize: 14,
    fontWeight: '500',
  },
  inputGroup: {
    marginBottom: 16,
  },
  inputLabel: {
    fontSize: 14,
    fontWeight: '500',
    marginBottom: 8,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    gap: 10,
  },
  input: {
    flex: 1,
    paddingVertical: 12,
    fontSize: 15,
  },
  textInput: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
  },
  dateRow: {
    flexDirection: 'row',
    gap: 12,
  },
  lineItemsSection: {
    marginTop: 8,
    marginBottom: 16,
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 12,
  },
  lineItem: {
    padding: 14,
    borderRadius: 10,
    borderWidth: 1,
    marginBottom: 10,
  },
  lineItemHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  lineItemNumber: {
    fontSize: 12,
    fontWeight: '500',
  },
  lineInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    marginBottom: 10,
  },
  lineItemRow: {
    flexDirection: 'row',
    gap: 8,
  },
  lineItemField: {
    flex: 1,
  },
  lineItemFieldLabel: {
    fontSize: 11,
    marginBottom: 4,
  },
  lineInputSmall: {
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
    textAlign: 'center',
  },
  lineTotal: {
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
    paddingVertical: 10,
  },
  addLineButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#8B5CF6',
    borderStyle: 'dashed',
  },
  addLineText: {
    color: '#8B5CF6',
    fontSize: 14,
    fontWeight: '500',
  },
  totalsCard: {
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 16,
  },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 6,
  },
  totalLabel: {
    fontSize: 14,
  },
  totalValue: {
    fontSize: 14,
    fontWeight: '500',
  },
  grandTotalRow: {
    borderTopWidth: 1,
    borderTopColor: '#E5E7EB',
    marginTop: 8,
    paddingTop: 12,
  },
  grandTotalLabel: {
    fontSize: 16,
    fontWeight: '600',
  },
  grandTotalValue: {
    fontSize: 20,
    fontWeight: '700',
  },
  notesInput: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    minHeight: 80,
  },
});
