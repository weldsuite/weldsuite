import React, { useState, useEffect } from 'react';
import {
  StyleSheet,
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  TextInput,
  Keyboard,
  Platform,
} from 'react-native';
import {
  X,
  ChevronDown,
  MoreHorizontal,
  Check,
  ArrowUp,
  Plus,
} from 'lucide-react-native';

// Light mode colors
const colors = {
  background: '#F8F9FA',
  card: '#FFFFFF',
  text: '#111827',
  muted: '#6B7280',
  border: '#E5E7EB',
  subtle: '#F3F4F6',
  primary: '#3B82F6',
};

// Status colors
const STATUS_CONFIG: Record<string, { label: string; bg: string; text: string }> = {
  // Goal statuses
  not_started: { label: 'Not Started', bg: '#FEE2E2', text: '#DC2626' },
  in_progress: { label: 'In Progress', bg: '#DBEAFE', text: '#2563EB' },
  at_risk: { label: 'At Risk', bg: '#FEF3C7', text: '#D97706' },
  completed: { label: 'Completed', bg: '#D1FAE5', text: '#059669' },
  // Task statuses
  todo: { label: 'To Do', bg: '#F3F4F6', text: '#6B7280' },
  done: { label: 'Done', bg: '#D1FAE5', text: '#059669' },
  blocked: { label: 'Blocked', bg: '#FEE2E2', text: '#DC2626' },
};

const PRIORITY_CONFIG: Record<string, { label: string; color: string }> = {
  low: { label: 'Low', color: '#6B7280' },
  medium: { label: 'Medium', color: '#F59E0B' },
  high: { label: 'High', color: '#EF4444' },
};

export interface DetailPanelItem {
  id: string;
  title: string;
  description?: string;
  status: string;
  priority?: string;
  dueDate?: string;
  startDate?: string;
  timeframe?: string;
  owner?: string;
  assigneeName?: string;
  progress?: number;
  subgoalsCount?: number;
  completedSubgoals?: number;
  tasksCount?: number;
}

export interface DetailPanelSubItem {
  id: string;
  title: string;
  status: string;
}

interface DetailPanelProps {
  item: DetailPanelItem;
  workspaceName?: string;
  subItems?: DetailPanelSubItem[];
  subItemsLabel?: string;
  onClose: () => void;
  onSubItemPress?: (item: DetailPanelSubItem) => void;
  onAddSubItem?: () => void;
  onEditPress?: () => void;
  editButtonLabel?: string;
  showCheckbox?: boolean;
}

export function DetailPanel({
  item,
  workspaceName = 'My workspace',
  subItems = [],
  subItemsLabel = 'Subtasks',
  onClose,
  onSubItemPress,
  onAddSubItem,
  onEditPress,
  editButtonLabel,
  showCheckbox = true,
}: DetailPanelProps) {
  const [activeTab, setActiveTab] = useState<'comments' | 'activity'>('comments');
  const [commentText, setCommentText] = useState('');
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  // Handle keyboard events
  useEffect(() => {
    const keyboardWillShow = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
      (e) => {
        setKeyboardHeight(e.endCoordinates.height);
      }
    );
    const keyboardWillHide = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
      () => {
        setKeyboardHeight(0);
      }
    );

    return () => {
      keyboardWillShow.remove();
      keyboardWillHide.remove();
    };
  }, []);

  const statusConfig = STATUS_CONFIG[item.status] || STATUS_CONFIG.not_started;
  const priorityConfig = item.priority ? PRIORITY_CONFIG[item.priority] : null;
  const ownerName = item.assigneeName || item.owner;

  return (
    <View style={styles.detailPanel}>
      {/* Header */}
      <View style={styles.panelHeader}>
        <View style={styles.panelHeaderLeft}>
          {showCheckbox && (
            <TouchableOpacity style={styles.panelCheckbox}>
              {(item.status === 'completed' || item.status === 'done') && (
                <Check size={14} color={colors.primary} strokeWidth={3} />
              )}
            </TouchableOpacity>
          )}
          <Text style={styles.panelTitle} numberOfLines={1}>{item.title}</Text>
        </View>
        <View style={styles.panelHeaderRight}>
          <TouchableOpacity style={styles.panelIconButton}>
            <MoreHorizontal size={18} color={colors.muted} />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.panelIconButton}
            onPress={onClose}
          >
            <X size={18} color={colors.muted} />
          </TouchableOpacity>
        </View>
      </View>
      <Text style={styles.panelSubtitle}>
        This task is visible to everyone in {workspaceName}.
      </Text>

      {/* Properties */}
      <ScrollView
        style={styles.panelBody}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
      >
        {ownerName && typeof ownerName === 'string' && (
          <View style={styles.propertyRow}>
            <Text style={styles.propertyLabel}>Assignee</Text>
            <View style={styles.propertyValue}>
              <View style={styles.assigneeAvatar}>
                <Text style={styles.assigneeAvatarText}>
                  {ownerName.charAt(0).toUpperCase()}
                </Text>
              </View>
              <Text style={styles.propertyText}>{ownerName}</Text>
            </View>
          </View>
        )}

        <View style={styles.propertyRow}>
          <Text style={styles.propertyLabel}>Due date</Text>
          <Text style={styles.propertyText}>
            {item.timeframe || (item.dueDate ? new Date(item.dueDate).toLocaleDateString() : 'Not set')}
          </Text>
        </View>

        {item.startDate && (
          <View style={styles.propertyRow}>
            <Text style={styles.propertyLabel}>Start date</Text>
            <Text style={styles.propertyText}>
              {new Date(item.startDate).toLocaleDateString()}
            </Text>
          </View>
        )}

        <View style={styles.propertyRow}>
          <Text style={styles.propertyLabel}>Project</Text>
          <Text style={styles.propertyText}>{workspaceName}</Text>
        </View>

        <View style={styles.propertyRow}>
          <Text style={styles.propertyLabel}>Status</Text>
          <View style={[styles.statusBadge, { backgroundColor: statusConfig.bg }]}>
            <Text style={[styles.statusBadgeText, { color: statusConfig.text }]}>
              {statusConfig.label}
            </Text>
          </View>
        </View>

        {priorityConfig && (
          <View style={styles.propertyRow}>
            <Text style={styles.propertyLabel}>Priority</Text>
            <View style={styles.priorityValue}>
              <ArrowUp size={14} color={priorityConfig.color} />
              <Text style={[styles.propertyText, { color: priorityConfig.color }]}>
                {priorityConfig.label}
              </Text>
            </View>
          </View>
        )}

        {item.progress !== undefined && (
          <View style={styles.propertyRow}>
            <Text style={styles.propertyLabel}>Progress</Text>
            <View style={styles.progressValue}>
              <View style={styles.progressBar}>
                <View style={[styles.progressFill, { width: `${item.progress}%` }]} />
              </View>
              <Text style={styles.propertyText}>{item.progress}%</Text>
            </View>
          </View>
        )}

        {item.description && (
          <View style={styles.propertyRow}>
            <Text style={styles.propertyLabel}>Description</Text>
            <Text style={styles.propertyText}>{item.description}</Text>
          </View>
        )}

        {/* Subtasks / Sub-items */}
        {(subItems.length > 0 || onAddSubItem) && (
          <View style={styles.subtasksSection}>
            <View style={styles.subtasksHeader}>
              <Text style={styles.subtasksTitle}>{subItemsLabel} ({subItems.length})</Text>
              {onAddSubItem && (
                <TouchableOpacity
                  style={styles.addSubtaskButton}
                  onPress={onAddSubItem}
                >
                  <Plus size={14} color={colors.muted} />
                  <Text style={styles.addSubtaskText}>Add</Text>
                </TouchableOpacity>
              )}
            </View>
            {subItems.map((subItem) => (
              <TouchableOpacity
                key={subItem.id}
                style={styles.subtaskItem}
                onPress={() => onSubItemPress?.(subItem)}
              >
                <View style={styles.subtaskCheckbox}>
                  {(subItem.status === 'completed' || subItem.status === 'done') && (
                    <Check size={12} color={colors.primary} strokeWidth={3} />
                  )}
                </View>
                <Text style={styles.subtaskText}>{subItem.title}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {/* Edit button */}
        {onEditPress && editButtonLabel && (
          <TouchableOpacity
            style={styles.editButton}
            onPress={onEditPress}
          >
            <Text style={styles.editButtonText}>{editButtonLabel}</Text>
          </TouchableOpacity>
        )}
      </ScrollView>

      {/* Comments Section - fixed at bottom */}
      <View style={[styles.commentsSection, { paddingBottom: keyboardHeight > 0 ? keyboardHeight + 16 : 20 }]}>
        <View style={styles.commentsTabs}>
          <TouchableOpacity
            style={[styles.commentTab, activeTab === 'comments' && styles.commentTabActive]}
            onPress={() => setActiveTab('comments')}
          >
            <Text style={[styles.commentTabText, activeTab === 'comments' && styles.commentTabTextActive]}>
              Comments
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.commentTab, activeTab === 'activity' && styles.commentTabActive]}
            onPress={() => setActiveTab('activity')}
          >
            <Text style={[styles.commentTabText, activeTab === 'activity' && styles.commentTabTextActive]}>
              All activity
            </Text>
          </TouchableOpacity>
          <View style={{ flex: 1 }} />
          <ChevronDown size={16} color={colors.muted} />
        </View>

        {/* ChatGPT-style input */}
        <View style={styles.chatInputWrapper}>
          <TextInput
            style={styles.chatInput}
            placeholder="Add a comment..."
            placeholderTextColor="#9CA3AF"
            value={commentText}
            onChangeText={setCommentText}
            multiline
            maxLength={1000}
          />
          <TouchableOpacity
            style={[
              styles.chatSendButton,
              commentText.trim() && styles.chatSendButtonActive,
            ]}
            disabled={!commentText.trim()}
          >
            <ArrowUp size={16} color={commentText.trim() ? '#FFFFFF' : '#9CA3AF'} strokeWidth={2.5} />
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  detailPanel: {
    flex: 0.35,
    backgroundColor: colors.card,
    borderLeftWidth: 1,
    borderLeftColor: colors.border,
  },
  panelHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 8,
  },
  panelHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    gap: 12,
  },
  panelHeaderRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  panelCheckbox: {
    width: 20,
    height: 20,
    borderRadius: 7,
    borderWidth: 1.5,
    borderColor: colors.border,
    justifyContent: 'center',
    alignItems: 'center',
  },
  panelTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.text,
    flex: 1,
  },
  panelIconButton: {
    width: 32,
    height: 32,
    borderRadius: 6,
    justifyContent: 'center',
    alignItems: 'center',
  },
  panelSubtitle: {
    fontSize: 13,
    color: colors.muted,
    paddingHorizontal: 20,
    paddingBottom: 16,
  },
  panelBody: {
    flex: 1,
    paddingHorizontal: 20,
  },
  propertyRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.subtle,
  },
  propertyLabel: {
    fontSize: 14,
    color: colors.muted,
  },
  propertyValue: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  propertyText: {
    fontSize: 14,
    color: colors.text,
  },
  statusBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
  },
  statusBadgeText: {
    fontSize: 12,
    fontWeight: '600',
  },
  priorityValue: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  assigneeAvatar: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#8B5CF6',
    justifyContent: 'center',
    alignItems: 'center',
  },
  assigneeAvatarText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  progressValue: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flex: 0.5,
  },
  progressBar: {
    flex: 1,
    height: 4,
    backgroundColor: colors.subtle,
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: '#22C55E',
    borderRadius: 2,
  },
  subtasksSection: {
    marginTop: 24,
  },
  subtasksHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  subtasksTitle: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.muted,
  },
  addSubtaskButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  addSubtaskText: {
    fontSize: 14,
    color: colors.muted,
  },
  subtaskItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
  },
  subtaskCheckbox: {
    width: 18,
    height: 18,
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: colors.border,
    justifyContent: 'center',
    alignItems: 'center',
  },
  subtaskText: {
    fontSize: 14,
    color: colors.text,
  },
  editButton: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    marginVertical: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.primary,
    backgroundColor: '#EFF6FF',
  },
  editButtonText: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.primary,
  },
  commentsSection: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: 16,
    paddingHorizontal: 20,
  },
  commentsTabs: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },
  commentTab: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
  },
  commentTabActive: {
    backgroundColor: colors.text,
  },
  commentTabText: {
    fontSize: 13,
    color: colors.muted,
    fontWeight: '500',
  },
  commentTabTextActive: {
    color: '#FFFFFF',
  },
  chatInputWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F3F4F6',
    borderRadius: 22,
    paddingLeft: 16,
    paddingRight: 6,
    paddingVertical: 6,
    minHeight: 44,
  },
  chatInput: {
    flex: 1,
    fontSize: 15,
    color: '#000000',
    maxHeight: 80,
    paddingVertical: 4,
  },
  chatSendButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#E5E7EB',
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 8,
  },
  chatSendButtonActive: {
    backgroundColor: '#000000',
  },
});
