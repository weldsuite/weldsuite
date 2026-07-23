import React, { useState } from 'react';
import { StyleSheet, View, Text, ScrollView, TouchableOpacity, Modal, TextInput, StatusBar } from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '@/contexts/ThemeContext';
import { ChevronLeft, Plus, X, FileText, DollarSign, Calendar, ChevronDown } from 'lucide-react-native';

interface Deal {
  id: string;
  title: string;
  company: string;
  value?: string;
  contact: string;
  date?: string;
}

interface Stage {
  id: string;
  name: string;
  deals: Deal[];
  color: string;
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

const pipelineData: Record<string, { name: string; stages: Stage[] }> = {
  '1': {
    name: 'Sales Pipeline',
    stages: [
      {
        id: 's1',
        name: 'Lead',
        color: '#94A3B8',
        deals: [
          { id: 'd1', title: 'Website Redesign', company: 'TechCorp', value: '$15,000', contact: 'John Smith', date: 'Jan 3, 2026' },
          { id: 'd2', title: 'Mobile App Development', company: 'StartupX', value: '$45,000', contact: 'Sarah Johnson', date: 'Jan 8, 2026' },
        ],
      },
      {
        id: 's2',
        name: 'Qualified',
        color: '#3B82F6',
        deals: [
          { id: 'd3', title: 'E-commerce Platform', company: 'RetailCo', value: '$32,000', contact: 'Mike Wilson', date: 'Jan 15, 2026' },
        ],
      },
      {
        id: 's3',
        name: 'Proposal',
        color: '#8B5CF6',
        deals: [
          { id: 'd4', title: 'CRM Integration', company: 'Global Inc', value: '$28,000', contact: 'Emily Brown', date: 'Jan 20, 2026' },
          { id: 'd5', title: 'Cloud Migration', company: 'DataTech', contact: 'David Lee', date: 'Jan 22, 2026' },
        ],
      },
      {
        id: 's4',
        name: 'Negotiation',
        color: '#F59E0B',
        deals: [
          { id: 'd6', title: 'Security Audit', company: 'FinanceGroup', value: '$18,000', contact: 'Lisa Chen', date: 'Feb 1, 2026' },
        ],
      },
      {
        id: 's5',
        name: 'Closed Won',
        color: '#10B981',
        deals: [
          { id: 'd7', title: 'API Development', company: 'DevCorp', value: '$22,000', contact: 'Tom Harris', date: 'Feb 10, 2026' },
        ],
      },
    ],
  },
  '2': {
    name: 'Enterprise Deals',
    stages: [
      {
        id: 's1',
        name: 'Discovery',
        color: '#94A3B8',
        deals: [
          { id: 'd1', title: 'Enterprise Software License', company: 'MegaCorp', value: '$150,000', contact: 'Jennifer White', date: 'Jan 5, 2026' },
        ],
      },
      {
        id: 's2',
        name: 'Demo',
        color: '#3B82F6',
        deals: [
          { id: 'd2', title: 'Custom Solution', company: 'BigTech', value: '$200,000', contact: 'Robert Taylor', date: 'Jan 12, 2026' },
        ],
      },
      {
        id: 's3',
        name: 'Proposal',
        color: '#8B5CF6',
        deals: [],
      },
      {
        id: 's4',
        name: 'Legal Review',
        color: '#F59E0B',
        deals: [
          { id: 'd3', title: 'Platform Integration', company: 'Enterprise Ltd', value: '$180,000', contact: 'Amanda Scott', date: 'Jan 25, 2026' },
        ],
      },
      {
        id: 's5',
        name: 'Contract',
        color: '#EF4444',
        deals: [],
      },
      {
        id: 's6',
        name: 'Closed Won',
        color: '#10B981',
        deals: [],
      },
    ],
  },
  '3': {
    name: 'Partner Onboarding',
    stages: [
      {
        id: 's1',
        name: 'Initial Contact',
        color: '#94A3B8',
        deals: [
          { id: 'd1', title: 'Reseller Agreement', company: 'Channel Partners', value: '$25,000', contact: 'Chris Martin', date: 'Jan 7, 2026' },
        ],
      },
      {
        id: 's2',
        name: 'Documentation',
        color: '#3B82F6',
        deals: [
          { id: 'd2', title: 'Integration Partner', company: 'SoftSolutions', value: '$18,000', contact: 'Patricia Lewis', date: 'Jan 14, 2026' },
        ],
      },
      {
        id: 's3',
        name: 'Training',
        color: '#8B5CF6',
        deals: [],
      },
      {
        id: 's4',
        name: 'Activated',
        color: '#10B981',
        deals: [
          { id: 'd3', title: 'Referral Partner', company: 'LeadGen Pro', value: '$12,000', contact: 'Kevin Moore', date: 'Jan 28, 2026' },
        ],
      },
    ],
  },
  '4': {
    name: 'Renewals',
    stages: [
      {
        id: 's1',
        name: 'Upcoming',
        color: '#94A3B8',
        deals: [
          { id: 'd1', title: 'Annual Subscription', company: 'ClientCo', value: '$35,000', contact: 'Nancy Clark', date: 'Feb 1, 2026' },
          { id: 'd2', title: 'Service Renewal', company: 'TechServices', value: '$28,000', contact: 'George King', date: 'Feb 5, 2026' },
        ],
      },
      {
        id: 's2',
        name: 'In Discussion',
        color: '#3B82F6',
        deals: [
          { id: 'd3', title: 'Support Package', company: 'SmallBiz Inc', contact: 'Helen Wright', date: 'Feb 12, 2026' },
        ],
      },
      {
        id: 's3',
        name: 'Renewed',
        color: '#10B981',
        deals: [
          { id: 'd4', title: 'Premium Plan', company: 'GrowthCo', value: '$42,000', contact: 'Frank Miller', date: 'Feb 20, 2026' },
        ],
      },
    ],
  },
};

export default function PipelineDetailScreen() {
  const { id } = useLocalSearchParams();
  const { colors } = useTheme();
  const initialPipeline = pipelineData[id as string];

  const [stages, setStages] = useState<Stage[]>(initialPipeline?.stages || []);

  // Customer Selection State
  const [isCustomerSelectVisible, setIsCustomerSelectVisible] = useState(false);
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [customerSearch, setCustomerSearch] = useState('');

  // Deal Modal State
  const [isCreateDealModalVisible, setIsCreateDealModalVisible] = useState(false);
  const [newDealTitle, setNewDealTitle] = useState('');
  const [newDealValue, setNewDealValue] = useState('');
  const [newDealClosingDate, setNewDealClosingDate] = useState('');
  const [newDealChance, setNewDealChance] = useState('');
  const [newDealNotes, setNewDealNotes] = useState('');
  const [selectedStage, setSelectedStage] = useState<string>('');
  const [selectedDeal, setSelectedDeal] = useState<{ deal: Deal; fromStageId: string } | null>(null);
  const [isMoveModalVisible, setIsMoveModalVisible] = useState(false);
  const [isChancePickerVisible, setIsChancePickerVisible] = useState(false);

  const chanceOptions = ['10%', '25%', '50%', '75%', '90%', '100%'];

  const filteredCustomers = mockCustomers.filter(c =>
    c.name.toLowerCase().includes(customerSearch.toLowerCase()) ||
    c.company.toLowerCase().includes(customerSearch.toLowerCase())
  );

  const openCustomerSelect = () => {
    setCustomerSearch('');
    setSelectedCustomer(null);
    setIsCustomerSelectVisible(true);
  };

  const handleCustomerSelect = (customer: Customer) => {
    setSelectedCustomer(customer);
    setIsCustomerSelectVisible(false);
    setIsCreateDealModalVisible(true);
  };

  const handleMoveDeal = (toStageId: string) => {
    if (!selectedDeal) return;

    const { deal, fromStageId } = selectedDeal;

    setStages(prevStages => {
      return prevStages.map(stage => {
        // Remove deal from source stage
        if (stage.id === fromStageId) {
          return {
            ...stage,
            deals: stage.deals.filter(d => d.id !== deal.id),
          };
        }
        // Add deal to target stage
        if (stage.id === toStageId) {
          return {
            ...stage,
            deals: [...stage.deals, deal],
          };
        }
        return stage;
      });
    });

    setSelectedDeal(null);
    setIsMoveModalVisible(false);
  };

  const handleDealLongPress = (deal: Deal, stageId: string) => {
    setSelectedDeal({ deal, fromStageId: stageId });
    setIsMoveModalVisible(true);
  };

  const handleCreateDeal = () => {
    if (!newDealTitle.trim() || !selectedStage || !selectedCustomer) return;

    const newDeal: Deal = {
      id: Date.now().toString(),
      title: newDealTitle,
      company: selectedCustomer.company,
      value: newDealValue ? `$${newDealValue}` : undefined,
      contact: selectedCustomer.name,
      date: newDealClosingDate || undefined,
    };

    setStages(prevStages => {
      return prevStages.map(stage => {
        if (stage.id === selectedStage) {
          return {
            ...stage,
            deals: [...stage.deals, newDeal],
          };
        }
        return stage;
      });
    });

    // Reset form
    setNewDealTitle('');
    setNewDealValue('');
    setNewDealClosingDate('');
    setNewDealChance('');
    setNewDealNotes('');
    setSelectedStage('');
    setSelectedCustomer(null);
    setIsCreateDealModalVisible(false);
  };

  const getSelectedStageName = () => {
    const stage = stages.find(s => s.id === selectedStage);
    return stage?.name || '';
  };

  const getCustomerInitials = () => {
    if (!selectedCustomer) return 'ND';
    return selectedCustomer.name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
  };

  if (!initialPipeline) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
        <Text style={{ color: colors.text }}>Pipeline not found</Text>
      </SafeAreaView>
    );
  }

  const DealCard = ({ deal, stageId }: { deal: Deal; stageId: string }) => (
    <TouchableOpacity
      style={[styles.dealCard, { backgroundColor: colors.background, borderColor: '#E5E7EB' }]}
      onPress={() => handleDealLongPress(deal, stageId)}
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
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={['top']}>
      {/* Header */}
      <View style={[styles.header, { backgroundColor: colors.background, borderBottomColor: colors.divider }]}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <TouchableOpacity
            onPress={() => router.back()}
            style={{
              backgroundColor: '#F3F4F6',
              borderRadius: 8,
              width: 32,
              height: 36,
              justifyContent: 'center',
              alignItems: 'center',
            }}
          >
            <ChevronLeft size={20} color="#374151" strokeWidth={2} />
          </TouchableOpacity>
          <Text style={[styles.headerTitle, { color: colors.text }]}>{initialPipeline.name}</Text>
        </View>
        <TouchableOpacity
          style={[styles.addDealButton, { backgroundColor: colors.background, borderColor: colors.buttonBorder }]}
          onPress={openCustomerSelect}
        >
          <Plus size={16} color={colors.text} strokeWidth={2} />
          <Text style={[styles.addDealButtonText, { color: colors.text }]}>Add</Text>
        </TouchableOpacity>
      </View>

      {/* Pipeline Stages */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.pipelineContainer}
        snapToInterval={296}
        decelerationRate="fast"
        snapToAlignment="start"
      >
        {stages.map((stage) => (
          <View key={stage.id} style={styles.stageColumn}>
            <View style={styles.stageHeader}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <View style={[styles.stageColorDot, { backgroundColor: stage.color }]} />
                <Text style={[styles.stageName, { color: colors.text }]}>{stage.name}</Text>
              </View>
              <View style={[styles.dealCountBadge, { backgroundColor: '#F3F4F6' }]}>
                <Text style={[styles.dealCountText, { color: '#6B7280' }]}>{stage.deals.length}</Text>
              </View>
            </View>

            <ScrollView
              style={styles.dealsScroll}
              showsVerticalScrollIndicator={false}
              contentContainerStyle={styles.dealsContainer}
            >
              {stage.deals.map((deal) => (
                <DealCard key={deal.id} deal={deal} stageId={stage.id} />
              ))}
              {stage.deals.length === 0 && (
                <View style={[styles.emptyState, { borderColor: colors.divider }]}>
                  <Text style={[styles.emptyText, { color: colors.muted }]}>No deals</Text>
                </View>
              )}
            </ScrollView>
          </View>
        ))}
      </ScrollView>

      {/* Customer Select Modal */}
      <Modal
        visible={isCustomerSelectVisible}
        animationType="fade"
        transparent={true}
        onRequestClose={() => setIsCustomerSelectVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.modalCard, { backgroundColor: colors.background }]}>
            {/* Header */}
            <View style={styles.compactModalHeader}>
              <Text style={[styles.modalTitle, { color: colors.text }]}>Select Customer</Text>
              <TouchableOpacity onPress={() => setIsCustomerSelectVisible(false)}>
                <X size={18} color="#9CA3AF" strokeWidth={2} />
              </TouchableOpacity>
            </View>

            {/* Search */}
            <View style={styles.searchContainer}>
              <TextInput
                style={[styles.searchInput, { color: colors.text }]}
                placeholder="Search customers..."
                placeholderTextColor="#A1A1AA"
                value={customerSearch}
                onChangeText={setCustomerSearch}
              />
            </View>

            {/* Customer List */}
            <ScrollView style={styles.customerList} showsVerticalScrollIndicator={false}>
              {filteredCustomers.map((customer) => (
                <TouchableOpacity
                  key={customer.id}
                  style={styles.customerItem}
                  onPress={() => handleCustomerSelect(customer)}
                >
                  <View style={styles.customerAvatar}>
                    <Text style={styles.customerAvatarText}>
                      {customer.name.split(' ').map(n => n[0]).join('').slice(0, 2)}
                    </Text>
                  </View>
                  <View style={styles.customerInfo}>
                    <Text style={[styles.customerName, { color: colors.text }]}>{customer.name}</Text>
                    <Text style={[styles.customerCompany, { color: colors.muted }]}>{customer.company}</Text>
                  </View>
                </TouchableOpacity>
              ))}
            </ScrollView>
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
          <View style={[styles.modalCard, { backgroundColor: colors.background }]}>
            {/* Header */}
            <View style={styles.compactModalHeader}>
              <View style={styles.headerLeft}>
                <View style={styles.compactAvatar}>
                  <Text style={styles.compactAvatarText}>
                    {getCustomerInitials()}
                  </Text>
                </View>
                <View>
                  <Text style={[styles.compactHeaderName, { color: colors.text }]} numberOfLines={1}>
                    {selectedCustomer?.name || 'New Deal'}
                  </Text>
                  <Text style={[styles.compactHeaderSub, { color: colors.muted }]}>
                    {selectedCustomer?.company} · {getSelectedStageName()}
                  </Text>
                </View>
              </View>
              <TouchableOpacity onPress={() => setIsCreateDealModalVisible(false)}>
                <X size={18} color="#9CA3AF" strokeWidth={2} />
              </TouchableOpacity>
            </View>

            {/* Content */}
            <ScrollView style={styles.compactContent} showsVerticalScrollIndicator={false}>
              {/* Deal Name */}
              <View style={styles.fieldGroup}>
                <Text style={styles.fieldLabel}>
                  Deal name <Text style={styles.required}>*</Text>
                </Text>
                <TextInput
                  style={[styles.input, { color: colors.text }]}
                  placeholder="e.g., Q4 Enterprise Deal"
                  placeholderTextColor="#A1A1AA"
                  value={newDealTitle}
                  onChangeText={setNewDealTitle}
                />
              </View>

              {/* Value */}
              <View style={styles.fieldGroup}>
                <Text style={styles.fieldLabel}>
                  Value <Text style={styles.required}>*</Text>
                </Text>
                <View style={styles.valueContainer}>
                  <Text style={styles.currencySymbol}>$</Text>
                  <TextInput
                    style={[styles.compactValueInput, { color: colors.text }]}
                    placeholder="50,000"
                    placeholderTextColor="#A1A1AA"
                    value={newDealValue}
                    onChangeText={setNewDealValue}
                    keyboardType="decimal-pad"
                  />
                </View>
              </View>

              {/* Two columns */}
              <View style={styles.row}>
                <View style={styles.halfField}>
                  <Text style={styles.fieldLabel}>Chance</Text>
                  <TouchableOpacity
                    style={styles.selectField}
                    onPress={() => setIsChancePickerVisible(!isChancePickerVisible)}
                  >
                    <Text style={[styles.selectText, { color: newDealChance ? colors.text : '#A1A1AA' }]}>
                      {newDealChance || 'Select'}
                    </Text>
                    <ChevronDown size={14} color="#A1A1AA" />
                  </TouchableOpacity>
                  {isChancePickerVisible && (
                    <View style={[styles.dropdown, { backgroundColor: colors.background }]}>
                      {chanceOptions.map((opt) => (
                        <TouchableOpacity
                          key={opt}
                          style={styles.dropdownOption}
                          onPress={() => { setNewDealChance(opt); setIsChancePickerVisible(false); }}
                        >
                          <Text style={[styles.dropdownText, { color: colors.text }]}>{opt}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  )}
                </View>
                <View style={styles.halfField}>
                  <Text style={styles.fieldLabel}>Closing date</Text>
                  <View style={styles.dateField}>
                    <TextInput
                      style={[styles.compactDateInput, { color: colors.text }]}
                      placeholder="1 Jan 2026"
                      placeholderTextColor="#A1A1AA"
                      value={newDealClosingDate}
                      onChangeText={setNewDealClosingDate}
                    />
                    <Calendar size={14} color="#A1A1AA" />
                  </View>
                </View>
              </View>

              {/* Notes */}
              <View style={styles.fieldGroup}>
                <Text style={styles.fieldLabel}>Notes</Text>
                <TextInput
                  style={[styles.textArea, { color: colors.text }]}
                  placeholder="Add notes..."
                  placeholderTextColor="#A1A1AA"
                  value={newDealNotes}
                  onChangeText={setNewDealNotes}
                  multiline
                  numberOfLines={3}
                  textAlignVertical="top"
                />
              </View>
            </ScrollView>

            {/* Footer */}
            <View style={styles.compactFooter}>
              <TouchableOpacity
                style={styles.btnOutline}
                onPress={() => setIsCreateDealModalVisible(false)}
              >
                <Text style={styles.btnOutlineText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.btnPrimary} onPress={handleCreateDeal}>
                <Text style={styles.btnPrimaryText}>Create Deal</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Move Deal Modal */}
      <Modal
        visible={isMoveModalVisible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setIsMoveModalVisible(false)}
      >
        <StatusBar barStyle="light-content" />
        <SafeAreaView style={[styles.modalContainer, { backgroundColor: colors.background }]}>
          {/* Modal Header */}
          <View style={[styles.modalHeader, { borderBottomColor: colors.divider }]}>
            <Text style={[styles.modalTitle, { color: colors.text }]}>Move Deal</Text>
            <TouchableOpacity
              onPress={() => setIsMoveModalVisible(false)}
              style={styles.closeButton}
            >
              <X size={20} color={colors.text} strokeWidth={2} />
            </TouchableOpacity>
          </View>

          {/* Modal Content */}
          <ScrollView style={styles.modalContent} showsVerticalScrollIndicator={false}>
            {selectedDeal && (
              <>
                {/* Deal Info */}
                <View style={[styles.moveDealInfo, { backgroundColor: '#F9FAFB', borderColor: '#E5E7EB' }]}>
                  <Text style={[styles.moveDealTitle, { color: colors.text }]}>{selectedDeal.deal.title}</Text>
                  <Text style={[styles.moveDealCompany, { color: colors.muted }]}>{selectedDeal.deal.company}</Text>
                </View>

                {/* Stage Selection */}
                <View style={styles.modalSection}>
                  <Text style={[styles.modalLabel, { color: '#374151' }]}>Move to Stage</Text>
                  <View style={styles.moveStageList}>
                    {stages
                      .filter(stage => stage.id !== selectedDeal.fromStageId)
                      .map((stage) => (
                        <TouchableOpacity
                          key={stage.id}
                          style={[styles.moveStageOption, { backgroundColor: colors.background, borderColor: '#E5E7EB' }]}
                          onPress={() => handleMoveDeal(stage.id)}
                        >
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                            <View style={[styles.stageOptionDot, { backgroundColor: stage.color }]} />
                            <Text style={[styles.moveStageText, { color: colors.text }]}>{stage.name}</Text>
                          </View>
                          <Text style={[styles.moveStageDealCount, { color: colors.muted }]}>
                            {stage.deals.length} {stage.deals.length === 1 ? 'deal' : 'deals'}
                          </Text>
                        </TouchableOpacity>
                      ))}
                  </View>
                </View>
              </>
            )}
          </ScrollView>
        </SafeAreaView>
      </Modal>
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
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '600',
  },
  addDealButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
  },
  addDealButtonText: {
    fontSize: 13,
    fontWeight: '500',
  },
  pipelineContainer: {
    paddingHorizontal: 16,
    paddingVertical: 16,
    gap: 16,
  },
  stageColumn: {
    width: 280,
  },
  stageHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  stageColorDot: {
    width: 10,
    height: 10,
    borderRadius: 3,
  },
  stageName: {
    fontSize: 15,
    fontWeight: '600',
  },
  dealCountBadge: {
    minWidth: 20,
    height: 20,
    paddingHorizontal: 6,
    borderRadius: 5,
    justifyContent: 'center',
    alignItems: 'center',
  },
  dealCountText: {
    fontSize: 11,
    fontWeight: '600',
  },
  dealsScroll: {
    flex: 1,
  },
  dealsContainer: {
    gap: 12,
    paddingBottom: 16,
  },
  dealCard: {
    borderRadius: 8,
    borderWidth: 1,
    padding: 12,
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
    fontSize: 14,
  },
  dealDate: {
    fontSize: 14,
  },
  emptyState: {
    borderRadius: 8,
    borderWidth: 1,
    borderStyle: 'dashed',
    padding: 24,
    alignItems: 'center',
  },
  emptyText: {
    fontSize: 13,
  },
  modalContainer: {
    flex: 1,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingTop: 16,
    borderBottomWidth: 1,
  },
  modalTitle: {
    fontSize: 17,
    fontWeight: '600',
    marginLeft: 16,
  },
  closeButton: {
    padding: 4,
    marginRight: 16,
  },
  modalContent: {
    flex: 1,
    paddingHorizontal: 20,
    paddingTop: 20,
  },
  modalSection: {
    marginBottom: 24,
  },
  modalLabel: {
    fontSize: 13,
    fontWeight: '500',
    marginBottom: 6,
  },
  modalInput: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
  },
  stageOptions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  stageOption: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 6,
    borderWidth: 1,
    gap: 6,
  },
  stageOptionDot: {
    width: 8,
    height: 8,
    borderRadius: 2,
  },
  stageOptionText: {
    fontSize: 13,
    fontWeight: '500',
  },
  createButtonContainer: {
    paddingHorizontal: 20,
    paddingVertical: 16,
  },
  createButton: {
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  createButtonText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  moveDealInfo: {
    padding: 16,
    borderRadius: 8,
    borderWidth: 1,
    marginBottom: 24,
  },
  moveDealTitle: {
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 4,
  },
  moveDealCompany: {
    fontSize: 13,
  },
  moveStageList: {
    gap: 8,
  },
  moveStageOption: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 14,
    borderRadius: 8,
    borderWidth: 1,
  },
  moveStageText: {
    fontSize: 14,
    fontWeight: '500',
  },
  moveStageDealCount: {
    fontSize: 12,
  },
  // Compact shadcn modal styles
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
  compactModalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#E4E4E7',
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  compactAvatar: {
    width: 32,
    height: 32,
    borderRadius: 6,
    backgroundColor: '#F4F4F5',
    justifyContent: 'center',
    alignItems: 'center',
  },
  compactAvatarText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#71717A',
  },
  compactHeaderName: {
    fontSize: 14,
    fontWeight: '600',
  },
  compactHeaderSub: {
    fontSize: 11,
    marginTop: 1,
  },
  compactContent: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    maxHeight: 320,
  },
  fieldGroup: {
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
  },
  valueContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#E4E4E7',
    borderRadius: 6,
    backgroundColor: '#FAFAFA',
    paddingHorizontal: 10,
  },
  currencySymbol: {
    fontSize: 13,
    color: '#71717A',
    marginRight: 4,
  },
  compactValueInput: {
    flex: 1,
    paddingVertical: 8,
    fontSize: 13,
  },
  row: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 12,
  },
  halfField: {
    flex: 1,
  },
  selectField: {
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
  },
  dateField: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#E4E4E7',
    borderRadius: 6,
    paddingHorizontal: 10,
    backgroundColor: '#FAFAFA',
  },
  compactDateInput: {
    flex: 1,
    paddingVertical: 8,
    fontSize: 13,
  },
  dropdown: {
    position: 'absolute',
    top: 58,
    left: 0,
    right: 0,
    borderWidth: 1,
    borderColor: '#E4E4E7',
    borderRadius: 6,
    zIndex: 100,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 4,
    elevation: 4,
  },
  dropdownOption: {
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  dropdownText: {
    fontSize: 13,
  },
  textArea: {
    borderWidth: 1,
    borderColor: '#E4E4E7',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
    backgroundColor: '#FAFAFA',
    minHeight: 60,
  },
  compactFooter: {
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
  // Customer Select Modal
  modalTitle: {
    fontSize: 14,
    fontWeight: '600',
  },
  searchContainer: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#E4E4E7',
  },
  searchInput: {
    backgroundColor: '#F4F4F5',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
  },
  customerList: {
    maxHeight: 280,
  },
  customerItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#F4F4F5',
  },
  customerAvatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#E4E4E7',
    justifyContent: 'center',
    alignItems: 'center',
  },
  customerAvatarText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#71717A',
  },
  customerInfo: {
    flex: 1,
  },
  customerName: {
    fontSize: 13,
    fontWeight: '500',
  },
  customerCompany: {
    fontSize: 11,
    marginTop: 1,
  },
});
