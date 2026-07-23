import React, { useState } from 'react';
import {
  StyleSheet,
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  Modal,
  TextInput,
} from 'react-native';
import { useTheme } from '@/contexts/ThemeContext';
import { useLocalSearchParams } from 'expo-router';
import { Plus, FileText, DollarSign, Calendar, X, ChevronLeft, ChevronDown } from 'lucide-react-native';

interface Deal {
  id: string;
  title: string;
  value?: string;
  date?: string;
}

interface Column {
  id: string;
  title: string;
  color: string;
  deals: Deal[];
}

interface Customer {
  id: string;
  name: string;
  company: string;
  email: string;
}

const mockCustomers: Customer[] = [
  { id: '1', name: 'John Smith', company: 'TechCorp', email: 'john@techcorp.com' },
  { id: '2', name: 'Sarah Johnson', company: 'StartupX', email: 'sarah@startupx.com' },
  { id: '3', name: 'Mike Wilson', company: 'RetailCo', email: 'mike@retailco.com' },
  { id: '4', name: 'Emily Brown', company: 'Global Inc', email: 'emily@globalinc.com' },
  { id: '5', name: 'David Lee', company: 'DataTech', email: 'david@datatech.com' },
  { id: '6', name: 'Lisa Chen', company: 'FinanceGroup', email: 'lisa@financegroup.com' },
];

export default function PipelinePage() {
  const { colors } = useTheme();
  const { id, name } = useLocalSearchParams<{ id: string; name?: string }>();

  const pageTitle = name || 'Pipeline';

  // Empty columns for the new pipeline
  const [columns] = useState<Column[]>([
    { id: 'lead', title: 'Lead', color: '#6B7280', deals: [] },
    { id: 'qualified', title: 'Qualified', color: '#3B82F6', deals: [] },
    { id: 'proposal', title: 'Proposal', color: '#8B5CF6', deals: [] },
    { id: 'negotiation', title: 'Negotiation', color: '#F59E0B', deals: [] },
    { id: 'closed_won', title: 'Closed Won', color: '#10B981', deals: [] },
  ]);

  // Customer Selection Modal State
  const [isCustomerSelectVisible, setIsCustomerSelectVisible] = useState(false);
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [customerSearch, setCustomerSearch] = useState('');

  // Create Deal Modal State
  const [isCreateDealModalVisible, setIsCreateDealModalVisible] = useState(false);
  const [selectedColumnId, setSelectedColumnId] = useState<string>('');
  const [newDealTitle, setNewDealTitle] = useState('');
  const [newDealValue, setNewDealValue] = useState('');
  const [newDealClosingDate, setNewDealClosingDate] = useState('');
  const [newDealChance, setNewDealChance] = useState('');
  const [newDealNotes, setNewDealNotes] = useState('');
  const [isChancePickerVisible, setIsChancePickerVisible] = useState(false);

  const chanceOptions = ['10%', '25%', '50%', '75%', '90%', '100%'];

  const filteredCustomers = mockCustomers.filter(c =>
    c.name.toLowerCase().includes(customerSearch.toLowerCase()) ||
    c.company.toLowerCase().includes(customerSearch.toLowerCase())
  );

  const openAddDeal = (columnId: string) => {
    setSelectedColumnId(columnId);
    setCustomerSearch('');
    setSelectedCustomer(null);
    setIsCustomerSelectVisible(true);
  };

  const handleCustomerSelect = (customer: Customer) => {
    setSelectedCustomer(customer);
    setIsCustomerSelectVisible(false);
    setNewDealTitle('');
    setNewDealValue('');
    setNewDealClosingDate('');
    setNewDealChance('');
    setNewDealNotes('');
    setIsCreateDealModalVisible(true);
  };

  const handleCreateDeal = () => {
    if (!newDealTitle.trim()) return;
    // Handle deal creation here
    setIsCreateDealModalVisible(false);
    resetDealForm();
  };

  const resetDealForm = () => {
    setNewDealTitle('');
    setNewDealValue('');
    setNewDealClosingDate('');
    setNewDealChance('');
    setNewDealNotes('');
    setSelectedCustomer(null);
    setSelectedColumnId('');
  };

  const getColumnStage = (columnId: string) => {
    const column = columns.find(c => c.id === columnId);
    return column?.title || 'Stage';
  };

  const getInitials = (name: string) => {
    return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
  };

  const DealCard = ({ deal }: { deal: Deal }) => (
    <TouchableOpacity
      style={[styles.dealCard, { backgroundColor: colors.background, borderColor: '#E5E7EB' }]}
      activeOpacity={0.7}
    >
      <View style={styles.dealRow}>
        <FileText size={16} color="#9CA3AF" strokeWidth={1.5} />
        <Text style={[styles.dealTitle, { color: colors.text }]} numberOfLines={1}>{deal.title}</Text>
      </View>
      <View style={styles.dealRow}>
        <DollarSign size={16} color="#9CA3AF" strokeWidth={1.5} />
        <Text style={[styles.dealValue, { color: deal.value ? colors.text : '#9CA3AF' }]}>
          {deal.value || 'Set Deal value...'}
        </Text>
      </View>
      <View style={styles.dealRow}>
        <Calendar size={16} color="#9CA3AF" strokeWidth={1.5} />
        <Text style={[styles.dealDate, { color: colors.text }]}>{deal.date || 'No date'}</Text>
      </View>
    </TouchableOpacity>
  );

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { backgroundColor: colors.background, borderBottomColor: colors.divider }]}>
        <Text style={[styles.headerTitle, { color: colors.text }]}>{pageTitle}</Text>
      </View>

      {/* Pipeline Columns */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.columnsContainer}
      >
        {columns.map((column) => (
          <View key={column.id} style={styles.column}>
            <View style={styles.columnHeader}>
              <View style={styles.columnTitleRow}>
                <View style={[styles.colorDot, { backgroundColor: column.color }]} />
                <Text style={[styles.columnTitle, { color: colors.text }]}>{column.title}</Text>
                <Text style={[styles.columnCount, { color: colors.muted }]}>{column.deals.length}</Text>
              </View>
              <TouchableOpacity
                style={[styles.addButton, { backgroundColor: '#F3F4F6' }]}
                onPress={() => openAddDeal(column.id)}
              >
                <Plus size={16} color="#6B7280" strokeWidth={2} />
              </TouchableOpacity>
            </View>

            <ScrollView style={styles.dealsContainer} showsVerticalScrollIndicator={false}>
              {column.deals.map((deal) => (
                <DealCard key={deal.id} deal={deal} />
              ))}
              {column.deals.length === 0 && (
                <View style={styles.emptyColumn}>
                  <Text style={[styles.emptyText, { color: colors.muted }]}>No deals</Text>
                </View>
              )}
            </ScrollView>
          </View>
        ))}
      </ScrollView>

      {/* Customer Selection Modal */}
      <Modal
        visible={isCustomerSelectVisible}
        animationType="fade"
        transparent={true}
        onRequestClose={() => setIsCustomerSelectVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.modalCard, { backgroundColor: '#FFFFFF' }]}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Select Customer</Text>
              <TouchableOpacity onPress={() => setIsCustomerSelectVisible(false)}>
                <X size={18} color="#9CA3AF" strokeWidth={2} />
              </TouchableOpacity>
            </View>
            <View style={styles.modalContent}>
              <TextInput
                style={styles.searchInput}
                placeholder="Search customers..."
                placeholderTextColor="#A1A1AA"
                value={customerSearch}
                onChangeText={setCustomerSearch}
              />
              <ScrollView style={styles.customerList}>
                {filteredCustomers.map((customer) => (
                  <TouchableOpacity
                    key={customer.id}
                    style={styles.customerItem}
                    onPress={() => handleCustomerSelect(customer)}
                  >
                    <View style={styles.customerAvatar}>
                      <Text style={styles.customerInitials}>{getInitials(customer.name)}</Text>
                    </View>
                    <View style={styles.customerInfo}>
                      <Text style={styles.customerName}>{customer.name}</Text>
                      <Text style={styles.customerCompany}>{customer.company}</Text>
                    </View>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>
          </View>
        </View>
      </Modal>

      {/* Create Deal Modal */}
      <Modal
        visible={isCreateDealModalVisible}
        animationType="fade"
        transparent={true}
        onRequestClose={() => setIsCreateDealModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.modalCard, { backgroundColor: '#FFFFFF' }]}>
            {/* Header with customer info */}
            <View style={styles.dealModalHeader}>
              <TouchableOpacity
                style={styles.backButton}
                onPress={() => {
                  setIsCreateDealModalVisible(false);
                  setIsCustomerSelectVisible(true);
                }}
              >
                <ChevronLeft size={18} color="#71717A" strokeWidth={2} />
              </TouchableOpacity>
              {selectedCustomer && (
                <View style={styles.selectedCustomerInfo}>
                  <View style={styles.customerAvatarSmall}>
                    <Text style={styles.customerInitialsSmall}>{getInitials(selectedCustomer.name)}</Text>
                  </View>
                  <View>
                    <Text style={styles.selectedCustomerName}>{selectedCustomer.name}</Text>
                    <Text style={styles.selectedCustomerStage}>Add to {getColumnStage(selectedColumnId)}</Text>
                  </View>
                </View>
              )}
              <TouchableOpacity onPress={() => setIsCreateDealModalVisible(false)}>
                <X size={18} color="#9CA3AF" strokeWidth={2} />
              </TouchableOpacity>
            </View>

            {/* Form */}
            <View style={styles.modalContent}>
              <View style={styles.formField}>
                <Text style={styles.fieldLabel}>Deal Name <Text style={styles.required}>*</Text></Text>
                <TextInput
                  style={styles.input}
                  placeholder="e.g., Q4 Enterprise Deal"
                  placeholderTextColor="#A1A1AA"
                  value={newDealTitle}
                  onChangeText={setNewDealTitle}
                />
              </View>

              <View style={styles.formField}>
                <Text style={styles.fieldLabel}>Value *</Text>
                <View style={styles.valueInputWrapper}>
                  <Text style={styles.currencyPrefix}>$</Text>
                  <TextInput
                    style={styles.valueInput}
                    placeholder="50.000"
                    placeholderTextColor="#A1A1AA"
                    value={newDealValue}
                    onChangeText={setNewDealValue}
                    keyboardType="numeric"
                  />
                </View>
              </View>

              <View style={styles.formRow}>
                <View style={[styles.formField, { flex: 1 }]}>
                  <Text style={styles.fieldLabel}>Chance</Text>
                  <TouchableOpacity
                    style={styles.selectInput}
                    onPress={() => setIsChancePickerVisible(!isChancePickerVisible)}
                  >
                    <Text style={[styles.selectText, !newDealChance && { color: '#A1A1AA' }]}>
                      {newDealChance || 'Select'}
                    </Text>
                    <ChevronDown size={16} color="#71717A" strokeWidth={2} />
                  </TouchableOpacity>
                  {isChancePickerVisible && (
                    <View style={styles.dropdown}>
                      {chanceOptions.map((option) => (
                        <TouchableOpacity
                          key={option}
                          style={styles.dropdownItem}
                          onPress={() => {
                            setNewDealChance(option);
                            setIsChancePickerVisible(false);
                          }}
                        >
                          <Text style={styles.dropdownText}>{option}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  )}
                </View>

                <View style={[styles.formField, { flex: 1.5 }]}>
                  <Text style={styles.fieldLabel}>Closing Date</Text>
                  <View style={styles.dateInputWrapper}>
                    <TextInput
                      style={styles.dateInput}
                      placeholder="1 jan 2025"
                      placeholderTextColor="#A1A1AA"
                      value={newDealClosingDate}
                      onChangeText={setNewDealClosingDate}
                    />
                    <Calendar size={16} color="#71717A" strokeWidth={2} />
                  </View>
                </View>
              </View>

              <View style={styles.formField}>
                <Text style={styles.fieldLabel}>Notes</Text>
                <TextInput
                  style={[styles.input, styles.textArea]}
                  placeholder="Add optional notes..."
                  placeholderTextColor="#A1A1AA"
                  value={newDealNotes}
                  onChangeText={setNewDealNotes}
                  multiline
                  numberOfLines={3}
                />
              </View>
            </View>

            {/* Footer */}
            <View style={styles.modalFooter}>
              <TouchableOpacity
                style={styles.btnOutline}
                onPress={() => setIsCreateDealModalVisible(false)}
              >
                <Text style={styles.btnOutlineText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.btnPrimary, !newDealTitle.trim() && styles.btnDisabled]}
                onPress={handleCreateDeal}
                disabled={!newDealTitle.trim()}
              >
                <Text style={styles.btnPrimaryText}>Create Deal</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    paddingHorizontal: 24,
    paddingTop: 24,
    paddingBottom: 16,
    borderBottomWidth: 0.5,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '600',
    letterSpacing: -0.3,
  },
  columnsContainer: {
    padding: 16,
    gap: 12,
  },
  column: {
    width: 280,
    marginRight: 12,
  },
  columnHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
    paddingHorizontal: 4,
  },
  columnTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  colorDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  columnTitle: {
    fontSize: 14,
    fontWeight: '600',
  },
  columnCount: {
    fontSize: 12,
    fontWeight: '500',
  },
  addButton: {
    width: 28,
    height: 28,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dealsContainer: {
    flex: 1,
  },
  dealCard: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
    gap: 10,
  },
  dealRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  dealTitle: {
    fontSize: 14,
    fontWeight: '500',
    flex: 1,
  },
  dealValue: {
    fontSize: 13,
    flex: 1,
  },
  dealDate: {
    fontSize: 13,
    flex: 1,
  },
  emptyColumn: {
    paddingVertical: 24,
    alignItems: 'center',
  },
  emptyText: {
    fontSize: 13,
  },
  // Modal styles
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modalCard: {
    width: '100%',
    maxWidth: 360,
    borderRadius: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 8,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#E4E4E7',
  },
  modalTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#18181B',
  },
  modalContent: {
    padding: 16,
  },
  searchInput: {
    borderWidth: 1,
    borderColor: '#E4E4E7',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
    backgroundColor: '#FAFAFA',
    color: '#18181B',
    marginBottom: 12,
  },
  customerList: {
    maxHeight: 200,
  },
  customerItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    gap: 10,
  },
  customerAvatar: {
    width: 32,
    height: 32,
    borderRadius: 6,
    backgroundColor: '#E4E4E7',
    alignItems: 'center',
    justifyContent: 'center',
  },
  customerInitials: {
    fontSize: 12,
    fontWeight: '600',
    color: '#52525B',
  },
  customerInfo: {
    flex: 1,
  },
  customerName: {
    fontSize: 13,
    fontWeight: '500',
    color: '#18181B',
  },
  customerCompany: {
    fontSize: 11,
    color: '#71717A',
  },
  dealModalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#E4E4E7',
    gap: 8,
  },
  backButton: {
    padding: 4,
  },
  selectedCustomerInfo: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  customerAvatarSmall: {
    width: 28,
    height: 28,
    borderRadius: 6,
    backgroundColor: '#E4E4E7',
    alignItems: 'center',
    justifyContent: 'center',
  },
  customerInitialsSmall: {
    fontSize: 10,
    fontWeight: '600',
    color: '#52525B',
  },
  selectedCustomerName: {
    fontSize: 13,
    fontWeight: '600',
    color: '#18181B',
  },
  selectedCustomerStage: {
    fontSize: 11,
    color: '#71717A',
  },
  formField: {
    marginBottom: 12,
  },
  fieldLabel: {
    fontSize: 12,
    fontWeight: '500',
    color: '#3F3F46',
    marginBottom: 4,
  },
  required: {
    color: '#EF4444',
  },
  input: {
    borderWidth: 1,
    borderColor: '#E4E4E7',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
    backgroundColor: '#FAFAFA',
    color: '#18181B',
  },
  textArea: {
    height: 60,
    textAlignVertical: 'top',
  },
  valueInputWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#E4E4E7',
    borderRadius: 6,
    backgroundColor: '#FAFAFA',
  },
  currencyPrefix: {
    paddingLeft: 10,
    fontSize: 13,
    color: '#71717A',
  },
  valueInput: {
    flex: 1,
    paddingHorizontal: 6,
    paddingVertical: 8,
    fontSize: 13,
    color: '#18181B',
  },
  formRow: {
    flexDirection: 'row',
    gap: 10,
  },
  selectInput: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: '#E4E4E7',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: '#FAFAFA',
  },
  selectText: {
    fontSize: 13,
    color: '#18181B',
  },
  dropdown: {
    position: 'absolute',
    top: '100%',
    left: 0,
    right: 0,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E4E4E7',
    borderRadius: 6,
    marginTop: 4,
    zIndex: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 4,
  },
  dropdownItem: {
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  dropdownText: {
    fontSize: 13,
    color: '#18181B',
  },
  dateInputWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#E4E4E7',
    borderRadius: 6,
    paddingRight: 10,
    backgroundColor: '#FAFAFA',
  },
  dateInput: {
    flex: 1,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
    color: '#18181B',
  },
  modalFooter: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: '#E4E4E7',
  },
  btnOutline: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 6,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#E4E4E7',
    backgroundColor: '#FFFFFF',
  },
  btnOutlineText: {
    fontSize: 13,
    fontWeight: '500',
    color: '#3F3F46',
  },
  btnPrimary: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 6,
    alignItems: 'center',
    backgroundColor: '#18181B',
  },
  btnPrimaryText: {
    fontSize: 13,
    fontWeight: '500',
    color: '#FFFFFF',
  },
  btnDisabled: {
    backgroundColor: '#A1A1AA',
  },
});
