import React, { useState, useEffect, useCallback } from 'react';
import {
  StyleSheet,
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Modal,
  TextInput,
  FlatList,
  RefreshControl,
  Linking,
  Alert,
} from 'react-native';
import { router } from 'expo-router';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import {
  Plus,
  FileText,
  DollarSign,
  Calendar,
  X,
  ChevronDown,
  List,
  Columns,
  Phone,
  Mail,
  Building2,
  MoreHorizontal,
  Edit3,
  Trash2,
  ExternalLink,
} from 'lucide-react-native';
import { api, type CustomerRecord, type PipelineWithStages, type OpportunityRecord } from '@/services/api';

type ViewMode = 'table' | 'pipeline';

interface Deal {
  id: string;
  title: string;
  value?: string;
  date?: string;
  customerId?: string;
}

interface Column {
  id: string;
  title: string;
  color: string;
  deals: Deal[];
}

export default function CustomersScreen() {
  const { colors } = useTheme();
  const toast = useToast();
  const [viewMode, setViewMode] = useState<ViewMode>('table');
  const [columns, setColumns] = useState<Column[]>([]);
  const [customers, setCustomers] = useState<CustomerRecord[]>([]);
  const [pipelines, setPipelines] = useState<PipelineWithStages[]>([]);
  const [opportunities, setOpportunities] = useState<OpportunityRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  // Customer Selection Modal State
  const [isCustomerSelectVisible, setIsCustomerSelectVisible] = useState(false);
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerRecord | null>(null);
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

  // Action Menu State
  const [isActionMenuVisible, setIsActionMenuVisible] = useState(false);
  const [actionMenuCustomer, setActionMenuCustomer] = useState<CustomerRecord | null>(null);

  const chanceOptions = ['10%', '25%', '50%', '75%', '90%', '100%'];

  const filteredCustomers = customers.filter(c => {
    const query = (searchQuery || customerSearch).toLowerCase();
    return (
      (c.fullName?.toLowerCase().includes(query)) ||
      (c.firstName?.toLowerCase().includes(query)) ||
      (c.lastName?.toLowerCase().includes(query)) ||
      (c.companyName?.toLowerCase().includes(query)) ||
      (c.email?.toLowerCase().includes(query))
    );
  });

  const formatRelativeTime = (dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return `${diffDays} days ago`;
    if (diffDays < 30) return `${Math.floor(diffDays / 7)} week${Math.floor(diffDays / 7) > 1 ? 's' : ''} ago`;
    return `${Math.floor(diffDays / 30)} month${Math.floor(diffDays / 30) > 1 ? 's' : ''} ago`;
  };

  const formatDate = (dateStr?: string) => {
    if (!dateStr) return 'No date';
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  const formatCurrency = (value?: string) => {
    if (!value) return undefined;
    const num = parseFloat(value);
    if (isNaN(num)) return value;
    return `$${num.toLocaleString()}`;
  };

  useEffect(() => {
    loadData();
  }, []);

  const loadData = useCallback(async () => {
    try {
      setLoading(true);

      // Fetch customers, pipelines, and opportunities in parallel
      const [customersRes, pipelinesRes, opportunitiesRes] = await Promise.all([
        api.getCrmCustomerRecords({ limit: 50 }),
        api.getPipelines(),
        api.getOpportunities({ limit: 100 }),
      ]);

      if (customersRes.success && customersRes.data) {
        // API returns items in 'items' field for paginated responses
        setCustomers(customersRes.data.items || customersRes.data.data || []);
      }

      if (pipelinesRes.success && pipelinesRes.data) {
        setPipelines(pipelinesRes.data);
      }

      if (opportunitiesRes.success && opportunitiesRes.data) {
        // API returns items in 'items' field for paginated responses
        setOpportunities(opportunitiesRes.data.items || opportunitiesRes.data.data || []);
      }

      // Build pipeline columns from real data
      if (pipelinesRes.success && pipelinesRes.data && pipelinesRes.data.length > 0) {
        const pipeline = pipelinesRes.data[0]; // Use first pipeline
        const opportunityData = opportunitiesRes.data?.items || opportunitiesRes.data?.data || [];

        const cols: Column[] = pipeline.stages.map(stage => ({
          id: stage.id,
          title: stage.name,
          color: stage.color || '#6B7280',
          deals: opportunityData
            .filter(opp => opp.stageId === stage.id)
            .map(opp => ({
              id: opp.id,
              title: opp.name,
              value: formatCurrency(opp.value),
              date: formatDate(opp.expectedCloseDate),
              customerId: opp.customerId,
            })),
        }));
        setColumns(cols);
      } else {
        // Fallback to default columns if no pipelines exist
        setColumns([
          { id: 'lead', title: 'Lead', color: '#6B7280', deals: [] },
          { id: 'qualified', title: 'Qualified', color: '#3B82F6', deals: [] },
          { id: 'proposal', title: 'Proposal', color: '#8B5CF6', deals: [] },
          { id: 'negotiation', title: 'Negotiation', color: '#F59E0B', deals: [] },
          { id: 'won', title: 'Won', color: '#10B981', deals: [] },
        ]);
      }
    } catch (error) {
      console.error('Error loading data:', error);
      toast.error('Failed to load data');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [toast]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    loadData();
  }, [loadData]);

  const openCustomerSelect = (columnId: string) => {
    setSelectedColumnId(columnId);
    setCustomerSearch('');
    setSelectedCustomer(null);
    setIsCustomerSelectVisible(true);
  };

  const handleCustomerSelect = (customer: CustomerRecord) => {
    setSelectedCustomer(customer);
    setIsCustomerSelectVisible(false);
    setIsCreateDealModalVisible(true);
  };

  const handleCreateDeal = async () => {
    if (!newDealTitle.trim() || !selectedColumnId || !selectedCustomer) return;

    try {
      // Parse closing date or use current date + 30 days as default
      let closeDate: string;
      if (newDealClosingDate) {
        // Try to parse the date string (e.g., "1 Jan 2026")
        const parsed = new Date(newDealClosingDate);
        closeDate = !isNaN(parsed.getTime()) ? parsed.toISOString() : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      } else {
        closeDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      }

      // Parse probability from chance string (e.g., "50%" -> 50)
      const probability = newDealChance ? parseInt(newDealChance.replace('%', '')) : undefined;

      // Get the first pipeline ID if available
      const pipelineId = pipelines.length > 0 ? pipelines[0].id : undefined;

      // Create the opportunity via API
      const response = await api.createOpportunity({
        name: newDealTitle.trim(),
        customerId: selectedCustomer.id,
        amount: newDealValue ? parseFloat(newDealValue) : 0,
        stageId: selectedColumnId,
        probability,
        closeDate,
        notes: newDealNotes || undefined,
        pipelineId,
      });

      if (response.success && response.data) {
        // Add to local state
        const newDeal: Deal = {
          id: response.data.id,
          title: newDealTitle,
          value: newDealValue ? `$${parseFloat(newDealValue).toLocaleString()}` : undefined,
          date: formatDate(closeDate),
          customerId: selectedCustomer.id,
        };

        setColumns(prevColumns => {
          return prevColumns.map(column => {
            if (column.id === selectedColumnId) {
              return {
                ...column,
                deals: [...column.deals, newDeal],
              };
            }
            return column;
          });
        });

        toast.success('Deal created successfully');
      } else {
        toast.error(typeof response.error === 'string' ? response.error : (response.error?.message || 'Failed to create deal'));
      }
    } catch (error) {
      console.error('Error creating deal:', error);
      toast.error('Failed to create deal');
    }

    // Reset form
    setNewDealTitle('');
    setNewDealValue('');
    setNewDealClosingDate('');
    setNewDealChance('');
    setNewDealNotes('');
    setSelectedCustomer(null);
    setSelectedColumnId('');
    setIsCreateDealModalVisible(false);
  };

  // Navigate to customer detail
  const handleCustomerPress = (customer: CustomerRecord) => {
    router.push({
      pathname: '/customer/[id]',
      params: { id: customer.id, name: getDisplayName(customer) },
    });
  };

  // Open action menu
  const openActionMenu = (customer: CustomerRecord) => {
    setActionMenuCustomer(customer);
    setIsActionMenuVisible(true);
  };

  // Action menu handlers
  const handleCallCustomer = () => {
    if (actionMenuCustomer?.phone || actionMenuCustomer?.mobile) {
      const phoneNumber = actionMenuCustomer.phone || actionMenuCustomer.mobile;
      Linking.openURL(`tel:${phoneNumber}`);
    } else {
      toast.error('No phone number available');
    }
    setIsActionMenuVisible(false);
  };

  const handleEmailCustomer = () => {
    if (actionMenuCustomer?.email) {
      Linking.openURL(`mailto:${actionMenuCustomer.email}`);
    }
    setIsActionMenuVisible(false);
  };

  const handleEditCustomer = () => {
    if (actionMenuCustomer) {
      router.push({
        pathname: '/customer/[id]',
        params: { id: actionMenuCustomer.id, name: getDisplayName(actionMenuCustomer), edit: 'true' },
      });
    }
    setIsActionMenuVisible(false);
  };

  const handleDeleteCustomer = () => {
    Alert.alert(
      'Delete Customer',
      `Are you sure you want to delete ${actionMenuCustomer ? getDisplayName(actionMenuCustomer) : 'this customer'}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            // TODO: Implement delete API call
            toast.success('Customer deleted');
            setCustomers(prev => prev.filter(c => c.id !== actionMenuCustomer?.id));
          },
        },
      ]
    );
    setIsActionMenuVisible(false);
  };

  const getSelectedColumnName = () => {
    const column = columns.find(c => c.id === selectedColumnId);
    return column?.title || '';
  };

  const getCustomerInitials = () => {
    if (!selectedCustomer) return 'ND';
    return getInitials(selectedCustomer);
  };

  const getStatusColor = (status?: string) => {
    const s = status?.toLowerCase();
    switch (s) {
      case 'active': return '#10B981';
      case 'lead': return '#3B82F6';
      case 'prospect': return '#F59E0B';
      case 'inactive': return '#9CA3AF';
      default: return '#6B7280';
    }
  };

  const getDisplayStatus = (status?: string) => {
    if (!status) return 'Unknown';
    return status.charAt(0).toUpperCase() + status.slice(1);
  };

  // Get display name from customer record (handles B2C and B2B)
  const getDisplayName = (customer: CustomerRecord) => {
    if (customer.fullName) return customer.fullName;
    if (customer.firstName || customer.lastName) {
      return [customer.firstName, customer.lastName].filter(Boolean).join(' ');
    }
    if (customer.companyName) return customer.companyName;
    return customer.email; // Fallback to email
  };

  const getInitials = (customer: CustomerRecord) => {
    const name = getDisplayName(customer);
    return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
  };

  // Table View Component
  const renderTableView = () => (
    <View style={styles.tableContainer}>
      {/* Search Bar */}
      <View style={[styles.searchBar, { backgroundColor: colors.background, borderColor: colors.divider }]}>
        <TextInput
          style={[styles.searchInput, { color: colors.text }]}
          placeholder="Search customers..."
          placeholderTextColor={colors.muted}
          value={searchQuery}
          onChangeText={setSearchQuery}
        />
      </View>

      {/* Customer List */}
      <FlatList
        data={filteredCustomers}
        keyExtractor={(item) => item.id}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Text style={[styles.emptyText, { color: colors.muted }]}>No customers found</Text>
          </View>
        }
        renderItem={({ item }) => (
          <TouchableOpacity
            style={[styles.customerCard, { backgroundColor: colors.background, borderColor: colors.divider }]}
            activeOpacity={0.7}
            onPress={() => handleCustomerPress(item)}
          >
            <View style={styles.customerHeader}>
              <View style={styles.customerAvatar}>
                <Text style={styles.customerAvatarText}>
                  {getInitials(item)}
                </Text>
              </View>
              <View style={styles.customerMainInfo}>
                <Text style={[styles.customerName, { color: colors.text }]}>{getDisplayName(item)}</Text>
                {item.companyName && (
                  <View style={styles.companyRow}>
                    <Building2 size={12} color={colors.muted} />
                    <Text style={[styles.customerCompany, { color: colors.muted }]}>{item.companyName}</Text>
                  </View>
                )}
              </View>
              <View style={[styles.statusBadge, { backgroundColor: `${getStatusColor(item.status)}15` }]}>
                <Text style={[styles.statusText, { color: getStatusColor(item.status) }]}>{getDisplayStatus(item.status)}</Text>
              </View>
            </View>

            <View style={styles.customerDetails}>
              {item.email && (
                <View style={styles.detailRow}>
                  <Mail size={14} color={colors.muted} />
                  <Text style={[styles.detailText, { color: colors.text }]}>{item.email}</Text>
                </View>
              )}
              {item.phone && (
                <View style={styles.detailRow}>
                  <Phone size={14} color={colors.muted} />
                  <Text style={[styles.detailText, { color: colors.text }]}>{item.phone}</Text>
                </View>
              )}
            </View>

            <View style={[styles.customerFooter, { borderTopColor: colors.divider }]}>
              <View style={styles.footerItem}>
                <Text style={[styles.footerLabel, { color: colors.muted }]}>Created</Text>
                <Text style={[styles.footerValue, { color: colors.text }]}>{formatRelativeTime(item.createdAt)}</Text>
              </View>
              <View style={styles.footerItem}>
                <Text style={[styles.footerLabel, { color: colors.muted }]}>Updated</Text>
                <Text style={[styles.footerValue, { color: colors.text }]}>{formatRelativeTime(item.updatedAt)}</Text>
              </View>
              <TouchableOpacity
                style={styles.moreButton}
                onPress={(e) => {
                  e.stopPropagation();
                  openActionMenu(item);
                }}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <MoreHorizontal size={18} color={colors.muted} />
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        )}
      />
    </View>
  );

  // Pipeline View Component
  const renderPipelineView = () => (
    <ScrollView
      style={styles.pipelineContainer}
      horizontal
      showsHorizontalScrollIndicator={false}
      bounces={false}
      directionalLockEnabled={true}
      contentContainerStyle={styles.columnsContainer}
    >
      {columns.map((column) => (
        <View key={column.id} style={styles.column}>
          {/* Column Header */}
          <View style={styles.columnHeader}>
            <View style={[styles.columnDot, { backgroundColor: column.color }]} />
            <Text style={[styles.columnTitle, { color: colors.text }]}>
              {column.title}
            </Text>
            <View style={styles.columnCountBadge}>
              <Text style={[styles.columnCount, { color: colors.muted }]}>
                {column.deals.length}
              </Text>
            </View>
          </View>

          {/* Deals */}
          <ScrollView
            style={styles.columnContent}
            showsVerticalScrollIndicator={false}
            nestedScrollEnabled={true}
            bounces={false}
          >
            {column.deals.map((deal) => (
              <TouchableOpacity
                key={deal.id}
                style={[
                  styles.dealCard,
                  { backgroundColor: colors.background, borderColor: colors.divider },
                ]}
                activeOpacity={0.7}
              >
                <View style={styles.dealRow}>
                  <FileText size={16} color="#9CA3AF" strokeWidth={1.5} />
                  <Text style={[styles.dealTitle, { color: colors.text }]} numberOfLines={1}>
                    {deal.title}
                  </Text>
                </View>
                <View style={styles.dealRow}>
                  <DollarSign size={16} color="#9CA3AF" strokeWidth={1.5} />
                  <Text style={[styles.dealValue, { color: deal.value ? colors.text : '#9CA3AF' }]}>
                    {deal.value || 'Set Deal value...'}
                  </Text>
                </View>
                <View style={styles.dealRow}>
                  <Calendar size={16} color="#9CA3AF" strokeWidth={1.5} />
                  <Text style={[styles.dealDate, { color: colors.text }]}>
                    {deal.date || 'No date'}
                  </Text>
                </View>
              </TouchableOpacity>
            ))}

            {/* Add Deal Button */}
            <TouchableOpacity
              style={[styles.addDealButton, { borderColor: colors.divider }]}
              onPress={() => openCustomerSelect(column.id)}
            >
              <Plus size={18} color={colors.muted} strokeWidth={2} />
              <Text style={[styles.addDealText, { color: colors.muted }]}>
                Add deal
              </Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      ))}
    </ScrollView>
  );

  if (loading && !refreshing) {
    return (
      <View style={[styles.centerContainer, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.text} />
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* View Toggle Header */}
      <View style={[styles.header, { borderBottomColor: colors.divider }]}>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Customers</Text>
        <View style={[styles.viewToggle, { backgroundColor: colors.background }]}>
          <TouchableOpacity
            style={[
              styles.toggleButton,
              viewMode === 'table' && styles.toggleButtonActive,
              viewMode === 'table' && { backgroundColor: colors.background }
            ]}
            onPress={() => setViewMode('table')}
          >
            <List size={16} color={viewMode === 'table' ? colors.text : colors.muted} />
            <Text style={[
              styles.toggleText,
              { color: viewMode === 'table' ? colors.text : colors.muted }
            ]}>Table</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[
              styles.toggleButton,
              viewMode === 'pipeline' && styles.toggleButtonActive,
              viewMode === 'pipeline' && { backgroundColor: colors.background }
            ]}
            onPress={() => setViewMode('pipeline')}
          >
            <Columns size={16} color={viewMode === 'pipeline' ? colors.text : colors.muted} />
            <Text style={[
              styles.toggleText,
              { color: viewMode === 'pipeline' ? colors.text : colors.muted }
            ]}>Pipeline</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Content */}
      {viewMode === 'table' ? renderTableView() : renderPipelineView()}

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
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: colors.text }]}>Select Customer</Text>
              <TouchableOpacity onPress={() => setIsCustomerSelectVisible(false)}>
                <X size={18} color="#9CA3AF" strokeWidth={2} />
              </TouchableOpacity>
            </View>

            {/* Search */}
            <View style={styles.modalSearchContainer}>
              <TextInput
                style={[styles.modalSearchInput, { color: colors.text }]}
                placeholder="Search customers..."
                placeholderTextColor="#A1A1AA"
                value={customerSearch}
                onChangeText={setCustomerSearch}
              />
            </View>

            {/* Customer List */}
            <ScrollView style={styles.modalCustomerList} showsVerticalScrollIndicator={false}>
              {filteredCustomers.length === 0 ? (
                <View style={styles.modalEmptyState}>
                  <Text style={[styles.emptyText, { color: colors.muted }]}>No customers found</Text>
                </View>
              ) : (
                filteredCustomers.map((customer) => (
                  <TouchableOpacity
                    key={customer.id}
                    style={styles.modalCustomerItem}
                    onPress={() => handleCustomerSelect(customer)}
                  >
                    <View style={styles.modalCustomerAvatar}>
                      <Text style={styles.modalCustomerAvatarText}>
                        {getInitials(customer)}
                      </Text>
                    </View>
                    <View style={styles.modalCustomerInfo}>
                      <Text style={[styles.modalCustomerName, { color: colors.text }]}>{getDisplayName(customer)}</Text>
                      <Text style={[styles.modalCustomerCompany, { color: colors.muted }]}>{customer.companyName || customer.email || '-'}</Text>
                    </View>
                  </TouchableOpacity>
                ))
              )}
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
            <View style={styles.modalHeader}>
              <View style={styles.headerLeft}>
                <View style={styles.headerAvatar}>
                  <Text style={styles.headerAvatarText}>
                    {getCustomerInitials()}
                  </Text>
                </View>
                <View>
                  <Text style={[styles.headerName, { color: colors.text }]} numberOfLines={1}>
                    {selectedCustomer ? getDisplayName(selectedCustomer) : 'New Deal'}
                  </Text>
                  <Text style={[styles.headerSubtitle, { color: colors.muted }]}>
                    {selectedCustomer?.companyName} · {getSelectedColumnName()}
                  </Text>
                </View>
              </View>
              <TouchableOpacity onPress={() => setIsCreateDealModalVisible(false)}>
                <X size={18} color="#9CA3AF" strokeWidth={2} />
              </TouchableOpacity>
            </View>

            {/* Content */}
            <ScrollView style={styles.modalContent} showsVerticalScrollIndicator={false}>
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
                    style={[styles.valueInput, { color: colors.text }]}
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
                      style={[styles.dateInput, { color: colors.text }]}
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
            <View style={styles.modalFooter}>
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

      {/* Action Menu Modal */}
      <Modal
        visible={isActionMenuVisible}
        animationType="fade"
        transparent={true}
        onRequestClose={() => setIsActionMenuVisible(false)}
      >
        <TouchableOpacity
          style={styles.actionMenuOverlay}
          activeOpacity={1}
          onPress={() => setIsActionMenuVisible(false)}
        >
          <View style={[styles.actionMenuCard, { backgroundColor: colors.background }]}>
            {/* Header */}
            <View style={styles.actionMenuHeader}>
              <View style={styles.actionMenuCustomerInfo}>
                <View style={styles.actionMenuAvatar}>
                  <Text style={styles.actionMenuAvatarText}>
                    {actionMenuCustomer ? getInitials(actionMenuCustomer) : '??'}
                  </Text>
                </View>
                <View>
                  <Text style={[styles.actionMenuName, { color: colors.text }]}>
                    {actionMenuCustomer ? getDisplayName(actionMenuCustomer) : ''}
                  </Text>
                  <Text style={[styles.actionMenuEmail, { color: colors.muted }]}>
                    {actionMenuCustomer?.email || ''}
                  </Text>
                </View>
              </View>
              <TouchableOpacity onPress={() => setIsActionMenuVisible(false)}>
                <X size={20} color={colors.muted} />
              </TouchableOpacity>
            </View>

            {/* Actions */}
            <View style={styles.actionMenuActions}>
              <TouchableOpacity style={styles.actionMenuItem} onPress={handleCallCustomer}>
                <Phone size={20} color={colors.text} />
                <Text style={[styles.actionMenuItemText, { color: colors.text }]}>Call</Text>
              </TouchableOpacity>

              <TouchableOpacity style={styles.actionMenuItem} onPress={handleEmailCustomer}>
                <Mail size={20} color={colors.text} />
                <Text style={[styles.actionMenuItemText, { color: colors.text }]}>Email</Text>
              </TouchableOpacity>

              <TouchableOpacity style={styles.actionMenuItem} onPress={handleEditCustomer}>
                <Edit3 size={20} color={colors.text} />
                <Text style={[styles.actionMenuItemText, { color: colors.text }]}>Edit</Text>
              </TouchableOpacity>

              <View style={[styles.actionMenuDivider, { backgroundColor: colors.divider }]} />

              <TouchableOpacity style={styles.actionMenuItem} onPress={handleDeleteCustomer}>
                <Trash2 size={20} color="#EF4444" />
                <Text style={[styles.actionMenuItemText, { color: '#EF4444' }]}>Delete</Text>
              </TouchableOpacity>
            </View>
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
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
  // Header with toggle
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '600',
  },
  viewToggle: {
    flexDirection: 'row',
    borderRadius: 8,
    padding: 3,
  },
  toggleButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    gap: 6,
  },
  toggleButtonActive: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  toggleText: {
    fontSize: 13,
    fontWeight: '500',
  },
  // Table View
  tableContainer: {
    flex: 1,
  },
  searchBar: {
    margin: 16,
    marginBottom: 8,
    borderRadius: 8,
    borderWidth: 1,
  },
  searchInput: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
  },
  listContent: {
    padding: 16,
    paddingTop: 8,
    flexGrow: 1,
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 40,
  },
  emptyText: {
    fontSize: 15,
  },
  customerCard: {
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 12,
    overflow: 'hidden',
  },
  customerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    gap: 12,
  },
  customerAvatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#E0E7FF',
    justifyContent: 'center',
    alignItems: 'center',
  },
  customerAvatarText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#4F46E5',
  },
  customerMainInfo: {
    flex: 1,
  },
  customerName: {
    fontSize: 15,
    fontWeight: '600',
  },
  companyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 2,
  },
  customerCompany: {
    fontSize: 13,
  },
  statusBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  statusText: {
    fontSize: 11,
    fontWeight: '600',
  },
  customerDetails: {
    paddingHorizontal: 14,
    paddingBottom: 12,
    gap: 6,
  },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  detailText: {
    fontSize: 13,
  },
  customerFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderTopWidth: 1,
  },
  footerItem: {
    flex: 1,
  },
  footerLabel: {
    fontSize: 11,
  },
  footerValue: {
    fontSize: 13,
    fontWeight: '600',
    marginTop: 2,
  },
  moreButton: {
    padding: 4,
  },
  // Pipeline View
  pipelineContainer: {
    flex: 1,
  },
  columnsContainer: {
    flexDirection: 'row',
    paddingVertical: 12,
  },
  column: {
    width: 280,
    paddingHorizontal: 12,
    height: '100%',
  },
  columnHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
    paddingHorizontal: 4,
  },
  columnDot: {
    width: 10,
    height: 10,
    borderRadius: 4,
  },
  columnTitle: {
    fontSize: 14,
    fontWeight: '600',
    flex: 1,
  },
  columnCountBadge: {
    backgroundColor: '#F3F4F6',
    width: 18,
    height: 18,
    borderRadius: 4,
    justifyContent: 'center',
    alignItems: 'center',
  },
  columnCount: {
    fontSize: 10,
    fontWeight: '500',
  },
  columnContent: {
    flex: 1,
  },
  dealCard: {
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
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
    fontSize: 14,
  },
  dealDate: {
    fontSize: 14,
  },
  addDealButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderRadius: 8,
  },
  addDealText: {
    fontSize: 13,
    fontWeight: '500',
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
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  headerAvatar: {
    width: 32,
    height: 32,
    borderRadius: 6,
    backgroundColor: '#F4F4F5',
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerAvatarText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#71717A',
  },
  headerName: {
    fontSize: 14,
    fontWeight: '600',
  },
  headerSubtitle: {
    fontSize: 11,
    marginTop: 1,
  },
  modalContent: {
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
  valueInput: {
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
  dateInput: {
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
  // Customer Select Modal
  modalTitle: {
    fontSize: 14,
    fontWeight: '600',
  },
  modalSearchContainer: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#E4E4E7',
  },
  modalSearchInput: {
    backgroundColor: '#F4F4F5',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
  },
  modalCustomerList: {
    maxHeight: 280,
  },
  modalEmptyState: {
    paddingVertical: 30,
    alignItems: 'center',
  },
  modalCustomerItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#F4F4F5',
  },
  modalCustomerAvatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#E4E4E7',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalCustomerAvatarText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#71717A',
  },
  modalCustomerInfo: {
    flex: 1,
  },
  modalCustomerName: {
    fontSize: 13,
    fontWeight: '500',
  },
  modalCustomerCompany: {
    fontSize: 11,
    marginTop: 1,
  },
  // Action Menu styles
  actionMenuOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'flex-end',
  },
  actionMenuCard: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingBottom: 34, // Safe area
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 8,
  },
  actionMenuHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#E4E4E7',
  },
  actionMenuCustomerInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    flex: 1,
  },
  actionMenuAvatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#E0E7FF',
    justifyContent: 'center',
    alignItems: 'center',
  },
  actionMenuAvatarText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#4F46E5',
  },
  actionMenuName: {
    fontSize: 16,
    fontWeight: '600',
  },
  actionMenuEmail: {
    fontSize: 13,
    marginTop: 2,
  },
  actionMenuActions: {
    paddingVertical: 8,
  },
  actionMenuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  actionMenuItemText: {
    fontSize: 16,
  },
  actionMenuDivider: {
    height: 1,
    marginVertical: 8,
    marginHorizontal: 20,
  },
});
