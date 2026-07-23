import { useCallback, useMemo, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  StyleSheet,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { ArrowLeft, Plus, Trash2 } from 'lucide-react-native';

import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import api from '@/services/api';
import { formatCurrency } from '@/lib/currency';

interface LineItem {
  key: string;
  description: string;
  quantity: string;
  unitPrice: string;
  taxRate: string;
}

function generateKey(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
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

function formatDateForInput(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatDateDisplay(dateStr: string): string {
  try {
    const date = new Date(dateStr + 'T00:00:00');
    return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return dateStr;
  }
}

export default function CreateInvoiceScreen() {
  const { colors } = useTheme();
  const router = useRouter();

  const today = new Date();
  const defaultDue = new Date(today);
  defaultDue.setDate(defaultDue.getDate() + 30);

  const [contactName, setContactName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [issueDate, setIssueDate] = useState(formatDateForInput(today));
  const [dueDate, setDueDate] = useState(formatDateForInput(defaultDue));
  const [lineItems, setLineItems] = useState<LineItem[]>([createEmptyLineItem()]);
  const [notes, setNotes] = useState('');
  const [reference, setReference] = useState('');
  const [saving, setSaving] = useState(false);

  const calculations = useMemo(() => {
    let subtotal = 0;
    let taxTotal = 0;

    const itemTotals = lineItems.map((item) => {
      const qty = parseFloat(item.quantity) || 0;
      const price = parseFloat(item.unitPrice) || 0;
      const rate = parseFloat(item.taxRate) || 0;
      const lineTotal = qty * price;
      const lineTax = lineTotal * (rate / 100);
      subtotal += lineTotal;
      taxTotal += lineTax;
      return { lineTotal, lineTax };
    });

    return {
      itemTotals,
      subtotal,
      taxTotal,
      total: subtotal + taxTotal,
    };
  }, [lineItems]);

  const updateLineItem = useCallback(
    (key: string, field: keyof LineItem, value: string) => {
      setLineItems((prev) =>
        prev.map((item) => (item.key === key ? { ...item, [field]: value } : item)),
      );
    },
    [],
  );

  const addLineItem = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setLineItems((prev) => [...prev, createEmptyLineItem()]);
  }, []);

  const removeLineItem = useCallback(
    (key: string) => {
      if (lineItems.length <= 1) return;
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      setLineItems((prev) => prev.filter((item) => item.key !== key));
    },
    [lineItems.length],
  );

  const validate = useCallback((): string | null => {
    if (!contactName.trim()) return 'Contact name is required';
    if (!issueDate.trim()) return 'Issue date is required';
    if (!dueDate.trim()) return 'Due date is required';

    const hasValidItem = lineItems.some(
      (item) =>
        item.description.trim() &&
        parseFloat(item.quantity) > 0 &&
        parseFloat(item.unitPrice) > 0,
    );
    if (!hasValidItem) return 'Add at least one valid line item';

    return null;
  }, [contactName, issueDate, dueDate, lineItems]);

  const buildPayload = useCallback(() => {
    const validItems = lineItems
      .filter(
        (item) =>
          item.description.trim() &&
          parseFloat(item.quantity) > 0 &&
          parseFloat(item.unitPrice) > 0,
      )
      .map((item, index) => ({
        description: item.description.trim(),
        quantity: parseFloat(item.quantity),
        unitPrice: parseFloat(item.unitPrice),
        taxRate: parseFloat(item.taxRate) || 0,
        sortOrder: index,
      }));

    return {
      contactName: contactName.trim(),
      contactEmail: contactEmail.trim() || undefined,
      issueDate,
      dueDate,
      notes: notes.trim() || undefined,
      reference: reference.trim() || undefined,
      items: validItems,
    };
  }, [contactName, contactEmail, issueDate, dueDate, lineItems, notes, reference]);

  const handleSave = useCallback(
    async (sendAfter: boolean) => {
      const validationError = validate();
      if (validationError) {
        Alert.alert('Validation Error', validationError);
        return;
      }

      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      setSaving(true);

      try {
        const payload = buildPayload();
        const response = await api.createInvoice({
          ...payload,
          status: sendAfter ? 'sent' : 'draft',
        });

        if (response.data?.id) {
          router.replace(`/invoice/${response.data.id}` as any);
        } else {
          router.back();
        }
      } catch (err) {
        Alert.alert('Error', 'Failed to create invoice. Please try again.');
      } finally {
        setSaving(false);
      }
    },
    [validate, buildPayload, router],
  );

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={styles.headerBar}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <ArrowLeft size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerBarTitle, { color: colors.text }]}>New Invoice</Text>
        <View style={styles.headerBarRight} />
      </View>

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={0}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {/* Contact Section */}
          <View style={[styles.card, { backgroundColor: colors.cardBackground }]}>
            <Text style={[styles.cardTitle, { color: colors.text }]}>Contact</Text>
            <View style={styles.fieldGroup}>
              <Text style={[styles.label, { color: colors.muted }]}>
                Name <Text style={styles.required}>*</Text>
              </Text>
              <TextInput
                style={[styles.input, { color: colors.text, backgroundColor: colors.background, borderColor: colors.divider }]}
                placeholder="Contact name"
                placeholderTextColor={colors.muted}
                value={contactName}
                onChangeText={setContactName}
                autoCapitalize="words"
              />
            </View>
            <View style={styles.fieldGroup}>
              <Text style={[styles.label, { color: colors.muted }]}>Email</Text>
              <TextInput
                style={[styles.input, { color: colors.text, backgroundColor: colors.background, borderColor: colors.divider }]}
                placeholder="contact@example.com"
                placeholderTextColor={colors.muted}
                value={contactEmail}
                onChangeText={setContactEmail}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>
          </View>

          {/* Dates Section */}
          <View style={[styles.card, { backgroundColor: colors.cardBackground }]}>
            <Text style={[styles.cardTitle, { color: colors.text }]}>Dates</Text>
            <View style={styles.dateFields}>
              <View style={[styles.fieldGroup, styles.flex]}>
                <Text style={[styles.label, { color: colors.muted }]}>
                  Issue Date <Text style={styles.required}>*</Text>
                </Text>
                <TextInput
                  style={[styles.input, { color: colors.text, backgroundColor: colors.background, borderColor: colors.divider }]}
                  placeholder="YYYY-MM-DD"
                  placeholderTextColor={colors.muted}
                  value={issueDate}
                  onChangeText={setIssueDate}
                  keyboardType="numbers-and-punctuation"
                />
                <Text style={[styles.datePreview, { color: colors.muted }]}>
                  {formatDateDisplay(issueDate)}
                </Text>
              </View>
              <View style={{ width: 12 }} />
              <View style={[styles.fieldGroup, styles.flex]}>
                <Text style={[styles.label, { color: colors.muted }]}>
                  Due Date <Text style={styles.required}>*</Text>
                </Text>
                <TextInput
                  style={[styles.input, { color: colors.text, backgroundColor: colors.background, borderColor: colors.divider }]}
                  placeholder="YYYY-MM-DD"
                  placeholderTextColor={colors.muted}
                  value={dueDate}
                  onChangeText={setDueDate}
                  keyboardType="numbers-and-punctuation"
                />
                <Text style={[styles.datePreview, { color: colors.muted }]}>
                  {formatDateDisplay(dueDate)}
                </Text>
              </View>
            </View>
          </View>

          {/* Line Items */}
          <View style={[styles.card, { backgroundColor: colors.cardBackground }]}>
            <Text style={[styles.cardTitle, { color: colors.text }]}>Line Items</Text>

            {lineItems.map((item, index) => {
              const lineTotal = calculations.itemTotals[index]?.lineTotal ?? 0;

              return (
                <View key={item.key} style={styles.lineItemContainer}>
                  {index > 0 && (
                    <View style={[styles.lineItemDivider, { backgroundColor: colors.divider }]} />
                  )}

                  <View style={styles.lineItemHeader}>
                    <Text style={[styles.lineItemIndex, { color: colors.muted }]}>
                      Item {index + 1}
                    </Text>
                    {lineItems.length > 1 && (
                      <TouchableOpacity
                        onPress={() => removeLineItem(item.key)}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      >
                        <Trash2 size={18} color="#EF4444" />
                      </TouchableOpacity>
                    )}
                  </View>

                  <View style={styles.fieldGroup}>
                    <Text style={[styles.label, { color: colors.muted }]}>Description</Text>
                    <TextInput
                      style={[styles.input, { color: colors.text, backgroundColor: colors.background, borderColor: colors.divider }]}
                      placeholder="Item description"
                      placeholderTextColor={colors.muted}
                      value={item.description}
                      onChangeText={(v) => updateLineItem(item.key, 'description', v)}
                    />
                  </View>

                  <View style={styles.lineItemFields}>
                    <View style={[styles.fieldGroup, { flex: 1 }]}>
                      <Text style={[styles.label, { color: colors.muted }]}>Qty</Text>
                      <TextInput
                        style={[styles.input, { color: colors.text, backgroundColor: colors.background, borderColor: colors.divider }]}
                        placeholder="1"
                        placeholderTextColor={colors.muted}
                        value={item.quantity}
                        onChangeText={(v) => updateLineItem(item.key, 'quantity', v)}
                        keyboardType="decimal-pad"
                      />
                    </View>
                    <View style={{ width: 10 }} />
                    <View style={[styles.fieldGroup, { flex: 2 }]}>
                      <Text style={[styles.label, { color: colors.muted }]}>Unit Price</Text>
                      <TextInput
                        style={[styles.input, { color: colors.text, backgroundColor: colors.background, borderColor: colors.divider }]}
                        placeholder="0.00"
                        placeholderTextColor={colors.muted}
                        value={item.unitPrice}
                        onChangeText={(v) => updateLineItem(item.key, 'unitPrice', v)}
                        keyboardType="decimal-pad"
                      />
                    </View>
                    <View style={{ width: 10 }} />
                    <View style={[styles.fieldGroup, { flex: 1 }]}>
                      <Text style={[styles.label, { color: colors.muted }]}>Tax %</Text>
                      <TextInput
                        style={[styles.input, { color: colors.text, backgroundColor: colors.background, borderColor: colors.divider }]}
                        placeholder="21"
                        placeholderTextColor={colors.muted}
                        value={item.taxRate}
                        onChangeText={(v) => updateLineItem(item.key, 'taxRate', v)}
                        keyboardType="decimal-pad"
                      />
                    </View>
                  </View>

                  <View style={styles.lineTotalRow}>
                    <Text style={[styles.lineTotalLabel, { color: colors.muted }]}>Line Total</Text>
                    <Text style={[styles.lineTotalValue, { color: colors.text }]}>
                      {formatCurrency(lineTotal)}
                    </Text>
                  </View>
                </View>
              );
            })}

            <TouchableOpacity
              style={[styles.addItemButton, { borderColor: colors.divider }]}
              onPress={addLineItem}
              activeOpacity={0.7}
            >
              <Plus size={18} color="#10B981" />
              <Text style={styles.addItemButtonText}>Add Line Item</Text>
            </TouchableOpacity>
          </View>

          {/* Totals Summary */}
          <View style={[styles.card, { backgroundColor: colors.cardBackground }]}>
            <View style={styles.summaryRow}>
              <Text style={[styles.summaryLabel, { color: colors.muted }]}>Subtotal</Text>
              <Text style={[styles.summaryValue, { color: colors.text }]}>
                {formatCurrency(calculations.subtotal)}
              </Text>
            </View>
            <View style={styles.summaryRow}>
              <Text style={[styles.summaryLabel, { color: colors.muted }]}>Tax</Text>
              <Text style={[styles.summaryValue, { color: colors.text }]}>
                {formatCurrency(calculations.taxTotal)}
              </Text>
            </View>
            <View style={[styles.summaryDivider, { backgroundColor: colors.divider }]} />
            <View style={styles.summaryRow}>
              <Text style={[styles.summaryLabelBold, { color: colors.text }]}>Total</Text>
              <Text style={[styles.summaryValueBold, { color: colors.text }]}>
                {formatCurrency(calculations.total)}
              </Text>
            </View>
          </View>

          {/* Notes & Reference */}
          <View style={[styles.card, { backgroundColor: colors.cardBackground }]}>
            <View style={styles.fieldGroup}>
              <Text style={[styles.label, { color: colors.muted }]}>Notes</Text>
              <TextInput
                style={[styles.input, styles.multilineInput, { color: colors.text, backgroundColor: colors.background, borderColor: colors.divider }]}
                placeholder="Notes to the client (optional)"
                placeholderTextColor={colors.muted}
                value={notes}
                onChangeText={setNotes}
                multiline
                numberOfLines={3}
                textAlignVertical="top"
              />
            </View>
            <View style={styles.fieldGroup}>
              <Text style={[styles.label, { color: colors.muted }]}>Reference</Text>
              <TextInput
                style={[styles.input, { color: colors.text, backgroundColor: colors.background, borderColor: colors.divider }]}
                placeholder="PO number or reference (optional)"
                placeholderTextColor={colors.muted}
                value={reference}
                onChangeText={setReference}
              />
            </View>
          </View>

          {/* Spacer for bottom bar */}
          <View style={{ height: 100 }} />
        </ScrollView>

        {/* Bottom Action Bar */}
        <View style={[styles.bottomBar, { backgroundColor: colors.background, borderTopColor: colors.divider }]}>
          <TouchableOpacity
            style={[styles.bottomButton, styles.draftButton, { borderColor: colors.divider }]}
            onPress={() => handleSave(false)}
            disabled={saving}
            activeOpacity={0.7}
          >
            {saving ? (
              <ActivityIndicator size="small" color={colors.text} />
            ) : (
              <Text style={[styles.draftButtonText, { color: colors.text }]}>Save Draft</Text>
            )}
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.bottomButton, styles.sendButton]}
            onPress={() => handleSave(true)}
            disabled={saving}
            activeOpacity={0.8}
          >
            {saving ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Text style={styles.sendButtonText}>Save & Send</Text>
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  flex: {
    flex: 1,
  },
  headerBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  backButton: {
    width: 40,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 4,
  },
  headerBarTitle: {
    flex: 1,
    fontSize: 18,
    fontWeight: '600',
  },
  headerBarRight: {
    width: 44,
  },
  scrollContent: {
    paddingHorizontal: 20,
  },
  card: {
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.06,
        shadowRadius: 4,
      },
      android: {
        elevation: 2,
      },
    }),
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 12,
  },
  fieldGroup: {
    marginBottom: 12,
  },
  label: {
    fontSize: 13,
    fontWeight: '500',
    marginBottom: 6,
  },
  required: {
    color: '#EF4444',
  },
  input: {
    height: 44,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    fontSize: 15,
  },
  multilineInput: {
    height: 80,
    paddingTop: 10,
    paddingBottom: 10,
  },
  dateFields: {
    flexDirection: 'row',
  },
  datePreview: {
    fontSize: 12,
    marginTop: 4,
  },
  lineItemContainer: {
    marginBottom: 4,
  },
  lineItemDivider: {
    height: 1,
    marginVertical: 16,
  },
  lineItemHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  lineItemIndex: {
    fontSize: 13,
    fontWeight: '600',
  },
  lineItemFields: {
    flexDirection: 'row',
  },
  lineTotalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 4,
    paddingTop: 8,
  },
  lineTotalLabel: {
    fontSize: 13,
  },
  lineTotalValue: {
    fontSize: 14,
    fontWeight: '600',
  },
  addItemButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderRadius: 8,
    marginTop: 8,
    gap: 6,
  },
  addItemButtonText: {
    color: '#10B981',
    fontSize: 14,
    fontWeight: '600',
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 6,
  },
  summaryLabel: {
    fontSize: 14,
  },
  summaryValue: {
    fontSize: 14,
  },
  summaryLabelBold: {
    fontSize: 16,
    fontWeight: '600',
  },
  summaryValueBold: {
    fontSize: 16,
    fontWeight: '700',
  },
  summaryDivider: {
    height: 1,
    marginVertical: 6,
  },
  bottomBar: {
    flexDirection: 'row',
    padding: 16,
    paddingBottom: Platform.OS === 'ios' ? 32 : 16,
    borderTopWidth: 1,
    gap: 12,
  },
  bottomButton: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  draftButton: {
    borderWidth: 1,
  },
  draftButtonText: {
    fontSize: 15,
    fontWeight: '600',
  },
  sendButton: {
    backgroundColor: '#10B981',
  },
  sendButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
});
