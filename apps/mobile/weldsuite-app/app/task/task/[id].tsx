import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/contexts/ThemeContext';
import { useLocalSearchParams, router } from 'expo-router';
import api from '@/services/api';
import {
  ChevronLeft,
  MoreVertical,
  Calendar,
  Flag,
  FolderKanban,
  Star,
  CheckCircle2,
  Circle,
  MessageSquare,
  Clock,
  Trash2,
  Edit3,
} from 'lucide-react-native';
import type { TaskItem, TaskPriority, TaskComment, TaskActivity } from '@/types/task.types';

export default function TaskDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();

  const [task, setTask] = useState<TaskItem | null>(null);
  const [comments, setComments] = useState<TaskComment[]>([]);
  const [activities, setActivities] = useState<TaskActivity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadTask();
  }, [id]);

  const loadTask = async () => {
    if (!id) return;

    setLoading(true);
    setError(null);

    try {
      const response = await api.getTask(id);
      if (response.success && response.data) {
        setTask(response.data);

        // Load comments
        const commentsResponse = await api.getTaskComments(id);
        if (commentsResponse.success && commentsResponse.data) {
          setComments(commentsResponse.data.items || commentsResponse.data || []);
        }
      } else {
        setError(response.error || 'Failed to load task');
      }
    } catch (err) {
      setError('An error occurred while loading the task');
    } finally {
      setLoading(false);
    }
  };

  const handleToggleComplete = async () => {
    if (!task) return;

    try {
      const response = await api.toggleTaskComplete(task.id);
      if (response.success) {
        setTask({
          ...task,
          status: task.status === 'completed' ? 'todo' : 'completed',
        });
      }
    } catch (err) {
      Alert.alert('Error', 'Failed to update task status');
    }
  };

  const handleToggleImportant = async () => {
    if (!task) return;

    try {
      const response = await api.toggleTaskImportant(task.id);
      if (response.success) {
        setTask({
          ...task,
          isImportant: !task.isImportant,
        });
      }
    } catch (err) {
      Alert.alert('Error', 'Failed to update task');
    }
  };

  const handleDelete = () => {
    Alert.alert('Delete Task', 'Are you sure you want to delete this task?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          if (!task) return;
          try {
            const response = await api.deleteTask(task.id);
            if (response.success) {
              router.back();
            } else {
              Alert.alert('Error', 'Failed to delete task');
            }
          } catch (err) {
            Alert.alert('Error', 'An error occurred while deleting the task');
          }
        },
      },
    ]);
  };

  if (loading) {
    return (
      <View style={[styles.loadingContainer, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color="#8B5CF6" />
        <Text style={[styles.loadingText, { color: colors.muted }]}>Loading task...</Text>
      </View>
    );
  }

  if (error || !task) {
    return (
      <View style={[styles.errorContainer, { backgroundColor: colors.background }]}>
        <Text style={[styles.errorText, { color: colors.text }]}>{error || 'Task not found'}</Text>
        <TouchableOpacity style={styles.retryButton} onPress={loadTask}>
          <Text style={styles.retryButtonText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + 10, borderBottomColor: colors.border }]}>
        <TouchableOpacity style={styles.backButton} onPress={() => router.back()}>
          <ChevronLeft size={24} color={colors.text} />
        </TouchableOpacity>
        <View style={styles.headerActions}>
          <TouchableOpacity style={styles.headerAction} onPress={handleToggleImportant}>
            <Star
              size={22}
              color={task.isImportant ? '#F59E0B' : colors.muted}
              fill={task.isImportant ? '#F59E0B' : 'transparent'}
            />
          </TouchableOpacity>
          <TouchableOpacity style={styles.headerAction} onPress={handleDelete}>
            <Trash2 size={22} color="#EF4444" />
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView
        style={styles.content}
        contentContainerStyle={[styles.contentContainer, { paddingBottom: insets.bottom + 20 }]}
      >
        {/* Task Status & Title */}
        <View style={styles.titleSection}>
          <TouchableOpacity style={styles.statusButton} onPress={handleToggleComplete}>
            {task.status === 'completed' ? (
              <CheckCircle2 size={28} color="#22C55E" fill="#22C55E" />
            ) : (
              <Circle size={28} color={getPriorityColor(task.priority)} strokeWidth={2} />
            )}
          </TouchableOpacity>
          <View style={styles.titleContent}>
            <Text
              style={[
                styles.title,
                { color: colors.text },
                task.status === 'completed' && styles.titleCompleted,
              ]}
            >
              {task.title}
            </Text>
            <View style={[styles.priorityBadge, { backgroundColor: getPriorityColor(task.priority) + '20' }]}>
              <Text style={[styles.priorityBadgeText, { color: getPriorityColor(task.priority) }]}>
                {task.priority.charAt(0).toUpperCase() + task.priority.slice(1)} Priority
              </Text>
            </View>
          </View>
        </View>

        {/* Description */}
        {task.description && (
          <View style={[styles.section, { borderBottomColor: colors.border }]}>
            <Text style={[styles.description, { color: colors.text }]}>{task.description}</Text>
          </View>
        )}

        {/* Details */}
        <View style={[styles.section, { borderBottomColor: colors.border }]}>
          {/* Due Date */}
          <View style={styles.detailRow}>
            <View style={styles.detailLabel}>
              <Calendar size={18} color={colors.muted} />
              <Text style={[styles.detailLabelText, { color: colors.muted }]}>Due Date</Text>
            </View>
            <Text style={[styles.detailValue, { color: task.dueDate ? colors.text : colors.muted }]}>
              {task.dueDate ? formatDate(task.dueDate) : 'No due date'}
            </Text>
          </View>

          {/* Project */}
          {task.projectName && (
            <View style={styles.detailRow}>
              <View style={styles.detailLabel}>
                <FolderKanban size={18} color={colors.muted} />
                <Text style={[styles.detailLabelText, { color: colors.muted }]}>Project</Text>
              </View>
              <Text style={[styles.detailValue, { color: colors.text }]}>{task.projectName}</Text>
            </View>
          )}

          {/* Assignee */}
          {task.assigneeName && (
            <View style={styles.detailRow}>
              <View style={styles.detailLabel}>
                <View
                  style={[
                    styles.assigneeAvatar,
                    { backgroundColor: '#8B5CF6' },
                  ]}
                >
                  <Text style={styles.assigneeInitial}>
                    {task.assigneeName.charAt(0).toUpperCase()}
                  </Text>
                </View>
                <Text style={[styles.detailLabelText, { color: colors.muted }]}>Assignee</Text>
              </View>
              <Text style={[styles.detailValue, { color: colors.text }]}>{task.assigneeName}</Text>
            </View>
          )}

          {/* Created */}
          <View style={styles.detailRow}>
            <View style={styles.detailLabel}>
              <Clock size={18} color={colors.muted} />
              <Text style={[styles.detailLabelText, { color: colors.muted }]}>Created</Text>
            </View>
            <Text style={[styles.detailValue, { color: colors.text }]}>
              {formatDate(task.createdAt)}
            </Text>
          </View>
        </View>

        {/* Tags */}
        {task.tags && task.tags.length > 0 && (
          <View style={[styles.section, { borderBottomColor: colors.border }]}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>Tags</Text>
            <View style={styles.tagsContainer}>
              {task.tags.map((tag, index) => (
                <View key={index} style={[styles.tag, { backgroundColor: '#EEF2FF' }]}>
                  <Text style={styles.tagText}>{tag}</Text>
                </View>
              ))}
            </View>
          </View>
        )}

        {/* Comments */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <MessageSquare size={18} color={colors.muted} />
            <Text style={[styles.sectionTitle, { color: colors.text }]}>
              Comments ({comments.length})
            </Text>
          </View>
          {comments.length === 0 ? (
            <Text style={[styles.noComments, { color: colors.muted }]}>No comments yet</Text>
          ) : (
            comments.map((comment) => (
              <View key={comment.id} style={[styles.comment, { borderColor: colors.border }]}>
                <View style={[styles.commentAvatar, { backgroundColor: '#8B5CF6' }]}>
                  <Text style={styles.commentAvatarText}>
                    {comment.authorName?.charAt(0).toUpperCase() || 'U'}
                  </Text>
                </View>
                <View style={styles.commentContent}>
                  <View style={styles.commentHeader}>
                    <Text style={[styles.commentAuthor, { color: colors.text }]}>
                      {comment.authorName}
                    </Text>
                    <Text style={[styles.commentDate, { color: colors.muted }]}>
                      {formatDate(comment.createdAt)}
                    </Text>
                  </View>
                  <Text style={[styles.commentText, { color: colors.text }]}>{comment.content}</Text>
                </View>
              </View>
            ))
          )}
        </View>
      </ScrollView>
    </View>
  );
}

function getPriorityColor(priority: TaskPriority): string {
  switch (priority) {
    case 'urgent':
      return '#EF4444';
    case 'high':
      return '#F59E0B';
    case 'medium':
      return '#3B82F6';
    case 'low':
    default:
      return '#6B7280';
  }
}

function formatDate(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
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
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  errorText: {
    fontSize: 16,
    textAlign: 'center',
  },
  retryButton: {
    marginTop: 16,
    paddingHorizontal: 20,
    paddingVertical: 10,
    backgroundColor: '#8B5CF6',
    borderRadius: 8,
  },
  retryButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
  },
  backButton: {
    padding: 4,
  },
  headerActions: {
    flexDirection: 'row',
    gap: 16,
  },
  headerAction: {
    padding: 4,
  },
  content: {
    flex: 1,
  },
  contentContainer: {
    padding: 16,
  },
  titleSection: {
    flexDirection: 'row',
    gap: 14,
    marginBottom: 20,
  },
  statusButton: {
    paddingTop: 4,
  },
  titleContent: {
    flex: 1,
  },
  title: {
    fontSize: 22,
    fontWeight: '600',
    lineHeight: 28,
  },
  titleCompleted: {
    textDecorationLine: 'line-through',
    opacity: 0.6,
  },
  priorityBadge: {
    alignSelf: 'flex-start',
    marginTop: 8,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
  },
  priorityBadgeText: {
    fontSize: 12,
    fontWeight: '500',
  },
  section: {
    paddingVertical: 16,
    borderBottomWidth: 1,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '600',
  },
  description: {
    fontSize: 15,
    lineHeight: 22,
  },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
  },
  detailLabel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  detailLabelText: {
    fontSize: 14,
  },
  detailValue: {
    fontSize: 14,
    fontWeight: '500',
  },
  assigneeAvatar: {
    width: 18,
    height: 18,
    borderRadius: 9,
    justifyContent: 'center',
    alignItems: 'center',
  },
  assigneeInitial: {
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: '600',
  },
  tagsContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 8,
  },
  tag: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
  },
  tagText: {
    fontSize: 12,
    color: '#6366F1',
    fontWeight: '500',
  },
  noComments: {
    fontSize: 14,
    marginTop: 8,
  },
  comment: {
    flexDirection: 'row',
    gap: 12,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  commentAvatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
  },
  commentAvatarText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  commentContent: {
    flex: 1,
  },
  commentHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  commentAuthor: {
    fontSize: 14,
    fontWeight: '600',
  },
  commentDate: {
    fontSize: 12,
  },
  commentText: {
    fontSize: 14,
    lineHeight: 20,
  },
});
