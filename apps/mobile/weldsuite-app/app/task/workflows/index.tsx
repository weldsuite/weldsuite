import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  RefreshControl,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/contexts/ThemeContext';
import { router } from 'expo-router';
import {
  Play,
  Pause,
  FileText,
  Plus,
  Upload,
  Filter,
  ArrowUpDown,
  Download,
  Search,
  GitBranch,
  Zap,
  MoreHorizontal,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react-native';

// Responsive breakpoint
const TABLET_MIN_WIDTH = 768;

interface Workflow {
  id: string;
  name: string;
  trigger: 'manual' | 'scheduled' | 'webhook' | 'event';
  steps: number;
  executions: number;
  lastRun: string | null;
  status: 'active' | 'paused' | 'draft';
  createdAt: string;
}

type FilterTab = 'all' | 'active' | 'paused' | 'draft';

// Mock data - replace with actual API call
const mockWorkflows: Workflow[] = [
  {
    id: '1',
    name: 'erf',
    trigger: 'manual',
    steps: 0,
    executions: 0,
    lastRun: null,
    status: 'draft',
    createdAt: '2026-01-04T14:44:00',
  },
  {
    id: '2',
    name: 'wedwed',
    trigger: 'manual',
    steps: 0,
    executions: 0,
    lastRun: null,
    status: 'draft',
    createdAt: '2026-01-03T23:12:00',
  },
];

export default function WorkflowsPage() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const { width: windowWidth } = useWindowDimensions();
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState<FilterTab>('all');
  const [searchQuery, setSearchQuery] = useState('');

  const isTablet = windowWidth >= TABLET_MIN_WIDTH;

  useEffect(() => {
    loadWorkflows();
  }, []);

  const loadWorkflows = async () => {
    try {
      setLoading(true);
      // TODO: Replace with actual API call
      await new Promise(resolve => setTimeout(resolve, 500));
      setWorkflows(mockWorkflows);
    } catch (error) {
      console.error('Error loading workflows:', error);
    } finally {
      setLoading(false);
    }
  };

  const onRefresh = async () => {
    setRefreshing(true);
    await loadWorkflows();
    setRefreshing(false);
  };

  const stats = {
    active: workflows.filter(w => w.status === 'active').length,
    paused: workflows.filter(w => w.status === 'paused').length,
    draft: workflows.filter(w => w.status === 'draft').length,
  };

  const filteredWorkflows = workflows.filter(w => {
    const matchesTab = activeTab === 'all' || w.status === activeTab;
    const matchesSearch = w.name.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesTab && matchesSearch;
  });

  const tabs: { key: FilterTab; label: string; count: number }[] = [
    { key: 'all', label: 'All', count: workflows.length },
    { key: 'active', label: 'Active', count: stats.active },
    { key: 'paused', label: 'Paused', count: stats.paused },
    { key: 'draft', label: 'Draft', count: stats.draft },
  ];

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    const day = date.getDate();
    const month = date.getMonth() + 1;
    const year = date.getFullYear();
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    return { date: `${day}-${month}-${year}`, time: `${hours}:${minutes}` };
  };

  const getTriggerLabel = (trigger: string) => {
    switch (trigger) {
      case 'manual': return 'Manual';
      case 'scheduled': return 'Scheduled';
      case 'webhook': return 'Webhook';
      case 'event': return 'Event';
      default: return trigger;
    }
  };

  if (loading && workflows.length === 0) {
    return (
      <View style={[styles.loadingContainer, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color="#111827" />
        <Text style={[styles.loadingText, { color: colors.muted }]}>Loading workflows...</Text>
      </View>
    );
  }

  // Render card item for phone view
  const renderWorkflowCard = (workflow: Workflow) => {
    const { date, time } = formatDate(workflow.createdAt);
    return (
      <TouchableOpacity
        key={workflow.id}
        style={[styles.workflowCard, { backgroundColor: colors.background, borderColor: colors.border }]}
        onPress={() => router.push(`/task/workflows/${workflow.id}` as any)}
      >
        <View style={styles.workflowCardHeader}>
          <View style={styles.workflowCardLeft}>
            <View style={styles.workflowCardIcon}>
              <GitBranch size={18} color="#6B7280" strokeWidth={2} />
            </View>
            <View>
              <Text style={[styles.workflowCardName, { color: colors.text }]}>{workflow.name}</Text>
              <View style={styles.workflowCardMeta}>
                <Zap size={12} color="#6B7280" strokeWidth={2} />
                <Text style={[styles.workflowCardMetaText, { color: colors.muted }]}>
                  {getTriggerLabel(workflow.trigger)}
                </Text>
              </View>
            </View>
          </View>
          <View style={[styles.statusBadge, getStatusStyle(workflow.status)]}>
            <Text style={[styles.statusText, { color: getStatusColor(workflow.status) }]}>
              {workflow.status.charAt(0).toUpperCase() + workflow.status.slice(1)}
            </Text>
          </View>
        </View>
        <View style={styles.workflowCardFooter}>
          <View style={styles.workflowCardStat}>
            <Text style={[styles.workflowCardStatLabel, { color: colors.muted }]}>Steps</Text>
            <Text style={[styles.workflowCardStatValue, { color: colors.text }]}>{workflow.steps}</Text>
          </View>
          <View style={styles.workflowCardStat}>
            <Text style={[styles.workflowCardStatLabel, { color: colors.muted }]}>Runs</Text>
            <Text style={[styles.workflowCardStatValue, { color: colors.text }]}>{workflow.executions}</Text>
          </View>
          <View style={styles.workflowCardStat}>
            <Text style={[styles.workflowCardStatLabel, { color: colors.muted }]}>Created</Text>
            <Text style={[styles.workflowCardStatValue, { color: colors.text }]}>{date}</Text>
          </View>
          <ChevronRight size={16} color={colors.muted} />
        </View>
      </TouchableOpacity>
    );
  };

  // Render table row for tablet view
  const renderTableRow = (workflow: Workflow, index: number) => {
    const { date, time } = formatDate(workflow.createdAt);
    const isLast = index === filteredWorkflows.length - 1;
    return (
      <TouchableOpacity
        key={workflow.id}
        style={[
          styles.tableRow,
          !isLast && { borderBottomColor: colors.border, borderBottomWidth: 1 },
        ]}
        onPress={() => router.push(`/task/workflows/${workflow.id}` as any)}
      >
        <View style={styles.checkboxCell}>
          <View style={[styles.checkbox, { borderColor: colors.border }]} />
        </View>
        <View style={styles.workflowCell}>
          <View style={styles.workflowIcon}>
            <GitBranch size={16} color="#6B7280" strokeWidth={2} />
          </View>
          <Text style={[styles.workflowName, { color: colors.text }]}>{workflow.name}</Text>
        </View>
        <View style={styles.triggerCell}>
          <Zap size={14} color="#6B7280" strokeWidth={2} />
          <Text style={[styles.cellText, { color: colors.text }]}>
            {getTriggerLabel(workflow.trigger)}
          </Text>
        </View>
        <View style={styles.stepsCell}>
          <Text style={[styles.cellText, { color: colors.text }]}>{workflow.steps}</Text>
        </View>
        <View style={styles.executionsCell}>
          <Text style={[styles.cellText, { color: colors.text }]}>{workflow.executions}</Text>
        </View>
        <View style={styles.lastRunCell}>
          <Text style={[styles.cellText, { color: colors.text }]}>
            {workflow.lastRun ? workflow.lastRun : 'Never'}
          </Text>
        </View>
        <View style={styles.statusCell}>
          <View style={[styles.statusBadge, getStatusStyle(workflow.status)]}>
            <FileText size={12} color={getStatusColor(workflow.status)} strokeWidth={2} />
            <Text style={[styles.statusText, { color: getStatusColor(workflow.status) }]}>
              {workflow.status.charAt(0).toUpperCase() + workflow.status.slice(1)}
            </Text>
          </View>
        </View>
        <View style={styles.createdCell}>
          <Text style={[styles.dateText, { color: colors.text }]}>{date}</Text>
          <Text style={[styles.timeText, { color: colors.muted }]}>{time}</Text>
        </View>
        <TouchableOpacity style={styles.actionsCell}>
          <MoreHorizontal size={18} color="#6B7280" strokeWidth={2} />
        </TouchableOpacity>
      </TouchableOpacity>
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      {/* Header */}
      <View style={[styles.header, isTablet && styles.headerTablet]}>
        <View style={styles.headerLeft}>
          {!isTablet && (
            <TouchableOpacity
              style={styles.backButton}
              onPress={() => router.back()}
            >
              <ChevronLeft size={24} color={colors.text} strokeWidth={2} />
            </TouchableOpacity>
          )}
          <View>
            <Text style={[styles.title, { color: colors.text }, !isTablet && styles.titlePhone]}>Workflows</Text>
            <View style={styles.statsRow}>
              <View style={styles.statItem}>
                <Play size={14} color="#22C55E" strokeWidth={2} />
                <Text style={[styles.statText, { color: colors.text }]}>{stats.active} Active</Text>
              </View>
              <Text style={[styles.statDivider, { color: colors.muted }]}>•</Text>
              <View style={styles.statItem}>
                <Pause size={14} color="#F59E0B" strokeWidth={2} />
                <Text style={[styles.statText, { color: colors.text }]}>{stats.paused} Paused</Text>
              </View>
              <Text style={[styles.statDivider, { color: colors.muted }]}>•</Text>
              <View style={styles.statItem}>
                <FileText size={14} color="#6B7280" strokeWidth={2} />
                <Text style={[styles.statText, { color: colors.text }]}>{stats.draft} Draft</Text>
              </View>
            </View>
          </View>
        </View>
        {isTablet && (
          <View style={styles.headerRight}>
            <TouchableOpacity style={styles.secondaryButton}>
              <Upload size={16} color="#374151" strokeWidth={2} />
              <Text style={styles.secondaryButtonText}>Browse Templates</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.primaryButton}
              onPress={() => router.push('/task/workflows/create' as any)}
            >
              <Plus size={16} color="#FFFFFF" strokeWidth={2} />
              <Text style={styles.primaryButtonText}>Create Workflow</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>

      {/* Filter Tabs & Search */}
      <View style={[styles.filterRow, !isTablet && styles.filterRowPhone]}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.tabsScroll}
          contentContainerStyle={styles.tabs}
        >
          {tabs.map(tab => (
            <TouchableOpacity
              key={tab.key}
              style={[
                styles.tab,
                activeTab === tab.key && styles.tabActive,
              ]}
              onPress={() => setActiveTab(tab.key)}
            >
              <Text
                style={[
                  styles.tabText,
                  activeTab === tab.key && styles.tabTextActive,
                ]}
              >
                {tab.label} ({tab.count})
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
        {isTablet && (
          <View style={styles.filterActions}>
            <TouchableOpacity style={styles.iconButton}>
              <Filter size={18} color="#6B7280" strokeWidth={2} />
            </TouchableOpacity>
            <TouchableOpacity style={styles.iconButton}>
              <ArrowUpDown size={18} color="#6B7280" strokeWidth={2} />
            </TouchableOpacity>
            <TouchableOpacity style={styles.iconButton}>
              <Download size={18} color="#6B7280" strokeWidth={2} />
            </TouchableOpacity>
            <View style={[styles.searchContainer, { borderColor: colors.border }]}>
              <Search size={16} color="#9CA3AF" strokeWidth={2} />
              <TextInput
                style={[styles.searchInput, { color: colors.text }]}
                placeholder="Search workflows..."
                placeholderTextColor="#9CA3AF"
                value={searchQuery}
                onChangeText={setSearchQuery}
              />
            </View>
          </View>
        )}
      </View>

      {/* Search bar for phone */}
      {!isTablet && (
        <View style={[styles.searchContainerPhone, { borderColor: colors.border }]}>
          <Search size={18} color="#9CA3AF" strokeWidth={2} />
          <TextInput
            style={[styles.searchInputPhone, { color: colors.text }]}
            placeholder="Search workflows..."
            placeholderTextColor="#9CA3AF"
            value={searchQuery}
            onChangeText={setSearchQuery}
          />
        </View>
      )}

      {/* Content */}
      <ScrollView
        style={styles.content}
        contentContainerStyle={[
          styles.contentContainer,
          { paddingBottom: insets.bottom + (isTablet ? 24 : 100) }
        ]}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
      >
        {filteredWorkflows.length === 0 ? (
          <View style={styles.emptyState}>
            <GitBranch size={48} color={colors.muted} strokeWidth={1.5} />
            <Text style={[styles.emptyTitle, { color: colors.text }]}>No workflows found</Text>
            <Text style={[styles.emptyText, { color: colors.muted }]}>
              {searchQuery ? 'Try a different search term' : 'Create your first workflow to get started'}
            </Text>
          </View>
        ) : isTablet ? (
          // Table view for tablet
          <View style={[styles.tableContainer, { borderColor: colors.border }]}>
            {/* Table Header */}
            <View style={[styles.tableHeader, { borderBottomColor: colors.border }]}>
              <View style={styles.checkboxCell}>
                <View style={[styles.checkbox, { borderColor: colors.border }]} />
              </View>
              <View style={styles.workflowCell}>
                <Text style={styles.columnHeader}>Workflow</Text>
                <ArrowUpDown size={12} color="#9CA3AF" strokeWidth={2} />
              </View>
              <View style={styles.triggerCell}>
                <Text style={styles.columnHeader}>Trigger</Text>
                <ArrowUpDown size={12} color="#9CA3AF" strokeWidth={2} />
              </View>
              <View style={styles.stepsCell}>
                <Text style={styles.columnHeader}>Steps</Text>
                <ArrowUpDown size={12} color="#9CA3AF" strokeWidth={2} />
              </View>
              <View style={styles.executionsCell}>
                <Text style={styles.columnHeader}>Executions</Text>
                <ArrowUpDown size={12} color="#9CA3AF" strokeWidth={2} />
              </View>
              <View style={styles.lastRunCell}>
                <Text style={styles.columnHeader}>Last Run</Text>
                <ArrowUpDown size={12} color="#9CA3AF" strokeWidth={2} />
              </View>
              <View style={styles.statusCell}>
                <Text style={styles.columnHeader}>Status</Text>
                <ArrowUpDown size={12} color="#9CA3AF" strokeWidth={2} />
              </View>
              <View style={styles.createdCell}>
                <Text style={styles.columnHeader}>Created</Text>
                <ArrowUpDown size={12} color="#9CA3AF" strokeWidth={2} />
              </View>
              <View style={styles.actionsCell} />
            </View>
            {/* Table Rows */}
            {filteredWorkflows.map((workflow, index) => renderTableRow(workflow, index))}
          </View>
        ) : (
          // Card view for phone
          <View style={styles.cardList}>
            {filteredWorkflows.map(workflow => renderWorkflowCard(workflow))}
          </View>
        )}
      </ScrollView>

      {/* FAB for phone */}
      {!isTablet && (
        <TouchableOpacity
          style={styles.fab}
          onPress={() => router.push('/task/workflows/create' as any)}
        >
          <Plus size={24} color="#FFFFFF" strokeWidth={2} />
        </TouchableOpacity>
      )}
    </View>
  );
}

function getStatusStyle(status: string) {
  switch (status) {
    case 'active':
      return { backgroundColor: '#DCFCE7' };
    case 'paused':
      return { backgroundColor: '#FEF3C7' };
    case 'draft':
    default:
      return { backgroundColor: '#F3F4F6' };
  }
}

function getStatusColor(status: string) {
  switch (status) {
    case 'active':
      return '#16A34A';
    case 'paused':
      return '#D97706';
    case 'draft':
    default:
      return '#4B5563';
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    marginTop: 12,
    fontSize: 14,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 16,
  },
  headerTablet: {
    paddingHorizontal: 24,
    paddingTop: 24,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  backButton: {
    padding: 4,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    marginBottom: 8,
  },
  titlePhone: {
    fontSize: 22,
  },
  statsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  statItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  statText: {
    fontSize: 14,
  },
  statDivider: {
    fontSize: 14,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  secondaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    backgroundColor: '#FFFFFF',
  },
  secondaryButtonText: {
    fontSize: 14,
    fontWeight: '500',
    color: '#374151',
  },
  primaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: '#111827',
  },
  primaryButtonText: {
    fontSize: 14,
    fontWeight: '500',
    color: '#FFFFFF',
  },
  filterRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingBottom: 16,
  },
  filterRowPhone: {
    paddingHorizontal: 16,
  },
  tabsScroll: {
    flexGrow: 0,
  },
  tabs: {
    flexDirection: 'row',
    gap: 4,
  },
  tab: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  tabActive: {
    backgroundColor: '#111827',
    borderColor: '#111827',
  },
  tabText: {
    fontSize: 14,
    fontWeight: '500',
    color: '#6B7280',
  },
  tabTextActive: {
    color: '#FFFFFF',
  },
  filterActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  iconButton: {
    padding: 8,
    borderRadius: 6,
  },
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    minWidth: 200,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    padding: 0,
  },
  searchContainerPhone: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginHorizontal: 16,
    marginBottom: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1,
    backgroundColor: '#F9FAFB',
  },
  searchInputPhone: {
    flex: 1,
    fontSize: 15,
    padding: 0,
  },
  content: {
    flex: 1,
  },
  contentContainer: {
    paddingHorizontal: 16,
  },
  cardList: {
    gap: 12,
  },
  workflowCard: {
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
  },
  workflowCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 16,
  },
  workflowCardLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  workflowCardIcon: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: '#F3F4F6',
    justifyContent: 'center',
    alignItems: 'center',
  },
  workflowCardName: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 4,
  },
  workflowCardMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  workflowCardMetaText: {
    fontSize: 13,
  },
  workflowCardFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#F3F4F6',
  },
  workflowCardStat: {
    flex: 1,
  },
  workflowCardStatLabel: {
    fontSize: 11,
    marginBottom: 2,
  },
  workflowCardStatValue: {
    fontSize: 14,
    fontWeight: '500',
  },
  tableContainer: {
    borderWidth: 1,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#FFFFFF',
    marginHorizontal: 8,
  },
  tableHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    backgroundColor: '#FAFAFA',
  },
  columnHeader: {
    fontSize: 13,
    fontWeight: '500',
    color: '#6B7280',
  },
  tableRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
  },
  checkboxCell: {
    width: 40,
    alignItems: 'center',
  },
  checkbox: {
    width: 18,
    height: 18,
    borderRadius: 4,
    borderWidth: 1.5,
  },
  workflowCell: {
    flex: 2,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  workflowIcon: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: '#F3F4F6',
    justifyContent: 'center',
    alignItems: 'center',
  },
  workflowName: {
    fontSize: 14,
    fontWeight: '500',
  },
  triggerCell: {
    flex: 1.5,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  stepsCell: {
    flex: 0.8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  executionsCell: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  lastRunCell: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  statusCell: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  createdCell: {
    flex: 1,
    flexDirection: 'column',
    gap: 2,
  },
  actionsCell: {
    width: 40,
    alignItems: 'center',
  },
  cellText: {
    fontSize: 14,
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
  },
  statusText: {
    fontSize: 13,
    fontWeight: '500',
  },
  dateText: {
    fontSize: 14,
  },
  timeText: {
    fontSize: 12,
  },
  emptyState: {
    paddingVertical: 60,
    alignItems: 'center',
    gap: 12,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '600',
    marginTop: 8,
  },
  emptyText: {
    fontSize: 14,
    textAlign: 'center',
    maxWidth: 280,
  },
  fab: {
    position: 'absolute',
    right: 20,
    bottom: 100,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#111827',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 8,
  },
});
