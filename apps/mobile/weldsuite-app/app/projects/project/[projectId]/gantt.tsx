import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { Animated } from 'react-native';
import {
  StyleSheet,
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  RefreshControl,
  ActivityIndicator,
  useWindowDimensions,
  Dimensions,
  NativeSyntheticEvent,
  NativeScrollEvent,
  Modal,
  Pressable,
  TextInput,
} from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useTheme } from '@/contexts/ThemeContext';
import { api } from '@/services/api';
import { Minus, Plus, X, Calendar, ChevronLeft, ChevronRight } from 'lucide-react-native';
import { DetailPanel } from '@/components/projects/DetailPanel';

interface ProjectTask {
  id: string;
  title: string;
  description?: string;
  status: string;
  priority: string;
  type?: string;
  progress?: number;
  assigneeId?: string;
  assigneeName?: string;
  startDate?: string;
  dueDate?: string;
  completedDate?: string;
  estimatedHours?: number;
  milestoneId?: string;
  createdAt?: string;
  updatedAt?: string;
}

type ViewMode = 'day' | 'week' | 'month' | 'quarter';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const LEFT_PANEL_WIDTH = 320;

// Base column widths for different view modes (at 100% zoom)
const BASE_COLUMN_WIDTHS: Record<ViewMode, number> = {
  day: 80,      // 40 * 2 (was 200% zoom)
  week: 120,    // 80 * 1.5 (was 150% zoom)
  month: 100,
  quarter: 112, // 150 * 0.75 (was 75% zoom)
};

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

interface TimePeriod {
  date: Date;
  label: string;
  subLabel?: string;
}

export default function ProjectGanttScreen() {
  const { projectId } = useLocalSearchParams<{ projectId: string }>();
  const { colors } = useTheme();
  const { width } = useWindowDimensions();

  // State
  const [tasks, setTasks] = useState<ProjectTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('month');
  const [zoom, setZoom] = useState(100);
  const [viewYear, setViewYear] = useState(() => new Date().getFullYear());

  const horizontalScrollRef = useRef<ScrollView>(null);
  const bodyHorizontalScrollRef = useRef<ScrollView>(null);
  const timelineBodyScrollRef = useRef<ScrollView>(null);
  const leftPanelScrollRef = useRef<ScrollView>(null);
  const scrollX = useRef(new Animated.Value(0)).current;
  const scrollY = useRef(new Animated.Value(0)).current;

  // Edit modal state
  const [selectedTask, setSelectedTask] = useState<ProjectTask | null>(null);
  const [editStartDate, setEditStartDate] = useState<Date>(new Date());
  const [editEndDate, setEditEndDate] = useState<Date>(new Date());
  const [editingField, setEditingField] = useState<'start' | 'end' | null>(null);
  const [saving, setSaving] = useState(false);

  // Add task modal state
  const [showAddModal, setShowAddModal] = useState(false);
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [newTaskStartDate, setNewTaskStartDate] = useState<Date>(new Date());
  const [newTaskEndDate, setNewTaskEndDate] = useState<Date>(() => {
    const date = new Date();
    date.setDate(date.getDate() + 7);
    return date;
  });
  const [creating, setCreating] = useState(false);

  // Detail panel state
  const [detailTask, setDetailTask] = useState<ProjectTask | null>(null);


  // Calculate column width based on view mode and zoom
  const columnWidth = useMemo(() => {
    return Math.round(BASE_COLUMN_WIDTHS[viewMode] * (zoom / 100));
  }, [viewMode, zoom]);

  // Generate time periods based on view mode
  const timePeriods = useMemo((): TimePeriod[] => {
    const periods: TimePeriod[] = [];
    const today = new Date();

    switch (viewMode) {
      case 'day': {
        // Show 30 days (2 weeks before, 2 weeks after today)
        const startDate = new Date(today);
        startDate.setDate(startDate.getDate() - 14);
        for (let i = 0; i < 42; i++) {
          const date = new Date(startDate);
          date.setDate(startDate.getDate() + i);
          periods.push({
            date,
            label: date.getDate().toString(),
            subLabel: DAYS[date.getDay()],
          });
        }
        break;
      }
      case 'week': {
        // Show 16 weeks (8 before, 8 after today)
        const startDate = new Date(today);
        startDate.setDate(startDate.getDate() - startDate.getDay() - 56); // Go to Sunday, 8 weeks back
        for (let i = 0; i < 20; i++) {
          const date = new Date(startDate);
          date.setDate(startDate.getDate() + i * 7);
          const weekNum = Math.ceil((date.getDate() + new Date(date.getFullYear(), date.getMonth(), 1).getDay()) / 7);
          periods.push({
            date,
            label: `W${weekNum}`,
            subLabel: `${MONTHS[date.getMonth()]} ${date.getDate()}`,
          });
        }
        break;
      }
      case 'month': {
        // Show 13 months (2 before, current, 10 after)
        const startDate = new Date(viewYear, today.getMonth() - 2, 1);
        for (let i = 0; i < 13; i++) {
          const date = new Date(startDate);
          date.setMonth(startDate.getMonth() + i);
          periods.push({
            date,
            label: MONTHS[date.getMonth()],
            subLabel: date.getFullYear().toString(),
          });
        }
        break;
      }
      case 'quarter': {
        // Show 8 quarters (2 before, current, 5 after)
        const currentQuarter = Math.floor(today.getMonth() / 3);
        const startQuarter = currentQuarter - 2;
        const startYear = viewYear + Math.floor(startQuarter / 4);
        const adjustedStartQuarter = ((startQuarter % 4) + 4) % 4;

        for (let i = 0; i < 8; i++) {
          const quarterIndex = (adjustedStartQuarter + i) % 4;
          const year = startYear + Math.floor((adjustedStartQuarter + i) / 4);
          const date = new Date(year, quarterIndex * 3, 1);
          periods.push({
            date,
            label: `Q${quarterIndex + 1}`,
            subLabel: year.toString(),
          });
        }
        break;
      }
    }
    return periods;
  }, [viewMode, viewYear]);

  // Load tasks
  const loadTasks = useCallback(async () => {
    if (!projectId) return;
    try {
      const response = await api.getProjectTasksList(projectId);
      if (response.success && response.data) {
        // Handle paginated response structure
        const taskItems = Array.isArray(response.data) ? response.data : response.data.items || [];
        // Only include tasks with dates
        const tasksWithDates = taskItems.filter(
          (t: ProjectTask) => t.startDate || t.dueDate
        );
        setTasks(tasksWithDates);
      }
    } catch (error) {
      console.error('Failed to load tasks:', error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [projectId]);

  useEffect(() => {
    loadTasks();
  }, [loadTasks]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    loadTasks();
  }, [loadTasks]);

  // Find today's index in time periods
  const getTodayIndex = useCallback(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (let i = 0; i < timePeriods.length; i++) {
      const period = timePeriods[i];
      const periodDate = new Date(period.date);
      periodDate.setHours(0, 0, 0, 0);

      switch (viewMode) {
        case 'day':
          if (periodDate.getTime() === today.getTime()) return i;
          break;
        case 'week': {
          const weekEnd = new Date(periodDate);
          weekEnd.setDate(weekEnd.getDate() + 6);
          if (today >= periodDate && today <= weekEnd) return i;
          break;
        }
        case 'month':
          if (periodDate.getMonth() === today.getMonth() && periodDate.getFullYear() === today.getFullYear()) return i;
          break;
        case 'quarter': {
          const quarterEnd = new Date(periodDate);
          quarterEnd.setMonth(quarterEnd.getMonth() + 3);
          quarterEnd.setDate(quarterEnd.getDate() - 1);
          if (today >= periodDate && today <= quarterEnd) return i;
          break;
        }
      }
    }
    return -1;
  }, [timePeriods, viewMode]);

  // Scroll to today on mount
  useEffect(() => {
    if (!loading && horizontalScrollRef.current && bodyHorizontalScrollRef.current) {
      const todayIndex = getTodayIndex();
      if (todayIndex > 0) {
        const scrollX = todayIndex * columnWidth - 50;
        setTimeout(() => {
          horizontalScrollRef.current?.scrollTo({
            x: scrollX,
            animated: false,
          });
          bodyHorizontalScrollRef.current?.scrollTo({
            x: scrollX,
            animated: false,
          });
        }, 100);
      }
    }
  }, [loading, timePeriods, columnWidth, getTodayIndex]);

  // Navigate to today
  const scrollToToday = () => {
    const today = new Date();
    setViewYear(today.getFullYear());
    const todayIndex = getTodayIndex();
    if (todayIndex >= 0) {
      horizontalScrollRef.current?.scrollTo({
        x: todayIndex * columnWidth - 50,
        animated: true,
      });
    }
  };

  // Format duration
  const formatDuration = (task: ProjectTask): string => {
    if (!task.startDate || !task.dueDate) {
      if (task.startDate || task.dueDate) {
        return '1 day';
      }
      return '';
    }

    const start = new Date(task.startDate);
    const end = new Date(task.dueDate);
    const diffTime = Math.abs(end.getTime() - start.getTime());
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    if (diffDays <= 7) {
      return `${diffDays} day${diffDays !== 1 ? 's' : ''}`;
    } else if (diffDays <= 45) {
      const weeks = Math.round(diffDays / 7);
      return weeks === 1 ? 'about 1 week' : `about ${weeks} weeks`;
    } else {
      const months = Math.round(diffDays / 30);
      return months === 1 ? 'about 1 month' : `${months} months`;
    }
  };

  // Get task bar position and width
  const getTaskBar = (task: ProjectTask) => {
    const startDate = task.startDate ? new Date(task.startDate) : new Date(task.dueDate!);
    const endDate = task.dueDate ? new Date(task.dueDate) : new Date(task.startDate!);
    startDate.setHours(0, 0, 0, 0);
    endDate.setHours(0, 0, 0, 0);

    if (timePeriods.length === 0) return null;

    const firstPeriodDate = new Date(timePeriods[0].date);
    const lastPeriodDate = new Date(timePeriods[timePeriods.length - 1].date);
    firstPeriodDate.setHours(0, 0, 0, 0);
    lastPeriodDate.setHours(0, 0, 0, 0);

    // Calculate the time span of the visible range based on view mode
    let lastPeriodEnd: Date;
    switch (viewMode) {
      case 'day':
        lastPeriodEnd = new Date(lastPeriodDate);
        lastPeriodEnd.setDate(lastPeriodEnd.getDate() + 1);
        break;
      case 'week':
        lastPeriodEnd = new Date(lastPeriodDate);
        lastPeriodEnd.setDate(lastPeriodEnd.getDate() + 7);
        break;
      case 'month':
        lastPeriodEnd = new Date(lastPeriodDate);
        lastPeriodEnd.setMonth(lastPeriodEnd.getMonth() + 1);
        break;
      case 'quarter':
        lastPeriodEnd = new Date(lastPeriodDate);
        lastPeriodEnd.setMonth(lastPeriodEnd.getMonth() + 3);
        break;
    }

    // Check if task is in visible range
    if (endDate < firstPeriodDate || startDate > lastPeriodEnd) {
      return null;
    }

    // Calculate position based on time
    const totalTimeSpan = lastPeriodEnd.getTime() - firstPeriodDate.getTime();
    const totalWidth = timePeriods.length * columnWidth;

    const clampedStart = Math.max(startDate.getTime(), firstPeriodDate.getTime());
    const clampedEnd = Math.min(endDate.getTime(), lastPeriodEnd.getTime());

    const startOffset = (clampedStart - firstPeriodDate.getTime()) / totalTimeSpan;
    const endOffset = (clampedEnd - firstPeriodDate.getTime()) / totalTimeSpan;

    const left = startOffset * totalWidth;
    const width = (endOffset - startOffset) * totalWidth;

    return {
      left: left + 2,
      width: Math.max(width - 4, 20),
    };
  };

  // Check if period contains today
  const isCurrentPeriod = (periodDate: Date) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const pDate = new Date(periodDate);
    pDate.setHours(0, 0, 0, 0);

    switch (viewMode) {
      case 'day':
        return pDate.getTime() === today.getTime();
      case 'week': {
        const weekEnd = new Date(pDate);
        weekEnd.setDate(weekEnd.getDate() + 6);
        return today >= pDate && today <= weekEnd;
      }
      case 'month':
        return pDate.getMonth() === today.getMonth() && pDate.getFullYear() === today.getFullYear();
      case 'quarter': {
        const quarterEnd = new Date(pDate);
        quarterEnd.setMonth(quarterEnd.getMonth() + 3);
        quarterEnd.setDate(quarterEnd.getDate() - 1);
        return today >= pDate && today <= quarterEnd;
      }
    }
  };

  // Get today marker position
  const getTodayPosition = () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (timePeriods.length === 0) return null;

    const firstPeriodDate = new Date(timePeriods[0].date);
    const lastPeriodDate = new Date(timePeriods[timePeriods.length - 1].date);
    firstPeriodDate.setHours(0, 0, 0, 0);
    lastPeriodDate.setHours(0, 0, 0, 0);

    // Calculate the end of the visible range
    let lastPeriodEnd: Date;
    switch (viewMode) {
      case 'day':
        lastPeriodEnd = new Date(lastPeriodDate);
        lastPeriodEnd.setDate(lastPeriodEnd.getDate() + 1);
        break;
      case 'week':
        lastPeriodEnd = new Date(lastPeriodDate);
        lastPeriodEnd.setDate(lastPeriodEnd.getDate() + 7);
        break;
      case 'month':
        lastPeriodEnd = new Date(lastPeriodDate);
        lastPeriodEnd.setMonth(lastPeriodEnd.getMonth() + 1);
        break;
      case 'quarter':
        lastPeriodEnd = new Date(lastPeriodDate);
        lastPeriodEnd.setMonth(lastPeriodEnd.getMonth() + 3);
        break;
    }

    // Check if today is in visible range
    if (today < firstPeriodDate || today > lastPeriodEnd) {
      return null;
    }

    // Calculate position
    const totalTimeSpan = lastPeriodEnd.getTime() - firstPeriodDate.getTime();
    const totalWidth = timePeriods.length * columnWidth;
    const todayOffset = (today.getTime() - firstPeriodDate.getTime()) / totalTimeSpan;

    return todayOffset * totalWidth;
  };

  // Handle view mode change
  const handleViewModeChange = (mode: ViewMode) => {
    setViewMode(mode);
    setZoom(100); // Reset to 100% for each view
  };

  // Zoom controls
  const handleZoomIn = () => setZoom(prev => Math.min(prev + 25, 200));
  const handleZoomOut = () => setZoom(prev => Math.max(prev - 25, 50));

  // Open task edit modal
  const openTaskModal = (task: ProjectTask) => {
    setSelectedTask(task);
    setEditStartDate(task.startDate ? new Date(task.startDate) : new Date());
    setEditEndDate(task.dueDate ? new Date(task.dueDate) : new Date());
    setEditingField(null);
  };

  // Close task edit modal
  const closeTaskModal = () => {
    setSelectedTask(null);
    setEditingField(null);
  };

  // Adjust date by days
  const adjustDate = (field: 'start' | 'end', days: number) => {
    if (field === 'start') {
      const newDate = new Date(editStartDate);
      newDate.setDate(newDate.getDate() + days);
      // Don't allow start date to be after end date
      if (newDate < editEndDate) {
        setEditStartDate(newDate);
      }
    } else {
      const newDate = new Date(editEndDate);
      newDate.setDate(newDate.getDate() + days);
      // Don't allow end date to be before start date
      if (newDate > editStartDate) {
        setEditEndDate(newDate);
      }
    }
  };

  // Save task dates
  const saveTaskDates = async () => {
    if (!selectedTask || !projectId) return;

    setSaving(true);
    try {
      await api.updateProjectTask(projectId, selectedTask.id, {
        startDate: editStartDate.toISOString(),
        dueDate: editEndDate.toISOString(),
      });

      // Update local state
      setTasks(prev =>
        prev.map(t =>
          t.id === selectedTask.id
            ? { ...t, startDate: editStartDate.toISOString(), dueDate: editEndDate.toISOString() }
            : t
        )
      );

      closeTaskModal();
    } catch (error) {
      console.error('Failed to save task:', error);
    } finally {
      setSaving(false);
    }
  };

  // Format date for display
  const formatDate = (date: Date) => {
    return date.toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  // Open add task modal
  const openAddModal = () => {
    setNewTaskTitle('');
    setNewTaskStartDate(new Date());
    const endDate = new Date();
    endDate.setDate(endDate.getDate() + 7);
    setNewTaskEndDate(endDate);
    setShowAddModal(true);
  };

  // Close add task modal
  const closeAddModal = () => {
    setShowAddModal(false);
    setNewTaskTitle('');
  };

  // Adjust new task date
  const adjustNewTaskDate = (field: 'start' | 'end', days: number) => {
    if (field === 'start') {
      const newDate = new Date(newTaskStartDate);
      newDate.setDate(newDate.getDate() + days);
      if (newDate < newTaskEndDate) {
        setNewTaskStartDate(newDate);
      }
    } else {
      const newDate = new Date(newTaskEndDate);
      newDate.setDate(newDate.getDate() + days);
      if (newDate > newTaskStartDate) {
        setNewTaskEndDate(newDate);
      }
    }
  };

  // Create new task
  const createTask = async () => {
    if (!projectId || !newTaskTitle.trim()) return;

    setCreating(true);
    try {
      const response = await api.createProjectTask(projectId, {
        title: newTaskTitle.trim(),
        startDate: newTaskStartDate.toISOString(),
        dueDate: newTaskEndDate.toISOString(),
        status: 'todo',
        priority: 'medium',
      });

      if (response.success && response.data) {
        setTasks(prev => [...prev, response.data]);
        closeAddModal();
      }
    } catch (error) {
      console.error('Failed to create task:', error);
    } finally {
      setCreating(false);
    }
  };

  // Sync vertical scroll - left panel follows timeline body
  useEffect(() => {
    const listenerId = scrollY.addListener(({ value }) => {
      leftPanelScrollRef.current?.scrollTo({
        y: value,
        animated: false,
      });
    });
    return () => scrollY.removeListener(listenerId);
  }, [scrollY]);

  // View mode button
  const ViewModeButton = ({ mode, label }: { mode: ViewMode; label: string }) => (
    <TouchableOpacity
      style={[
        styles.viewModeButton,
        viewMode === mode && styles.viewModeButtonActive,
      ]}
      onPress={() => handleViewModeChange(mode)}
    >
      <Text
        style={[
          styles.viewModeButtonText,
          viewMode === mode && styles.viewModeButtonTextActive,
        ]}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );

  if (loading) {
    return (
      <View style={[styles.container, styles.centered, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  const todayPosition = getTodayPosition();

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Toolbar */}
      <View style={[styles.toolbar, { borderBottomColor: colors.border }]}>
        {/* View mode toggle */}
        <View style={styles.viewModeToggle}>
          <ViewModeButton mode="day" label="Day" />
          <ViewModeButton mode="week" label="Week" />
          <ViewModeButton mode="month" label="Month" />
          <ViewModeButton mode="quarter" label="Quarter" />
        </View>

        {/* Zoom controls */}
        <View style={styles.zoomControls}>
          <TouchableOpacity style={styles.zoomButton} onPress={handleZoomOut}>
            <Minus size={16} color="#374151" strokeWidth={1.5} />
          </TouchableOpacity>
          <Text style={styles.zoomText}>{zoom}%</Text>
          <TouchableOpacity style={styles.zoomButton} onPress={handleZoomIn}>
            <Plus size={16} color="#374151" strokeWidth={1.5} />
          </TouchableOpacity>
        </View>
      </View>

      {/* Main content */}
      <View style={styles.mainContent}>
        {/* Gantt content */}
        <View style={[styles.ganttContent, detailTask && styles.ganttContentWithPanel]}>
          {/* Left panel - Issues list */}
          <View style={[styles.leftPanel, { borderRightColor: colors.border }]}>
          {/* Left panel header */}
          <View style={[styles.leftPanelHeader, { borderBottomColor: colors.border }]}>
            <Text style={[styles.issuesLabel, { color: colors.text }]}>Tasks</Text>
            <View style={styles.durationColumn}>
              <TouchableOpacity style={styles.addButton} onPress={openAddModal}>
                <Plus size={14} color={colors.muted} strokeWidth={1.5} />
              </TouchableOpacity>
              <Text style={[styles.durationLabel, { color: colors.text }]}>Duration</Text>
            </View>
          </View>

          {/* Issues list */}
          <ScrollView
            ref={leftPanelScrollRef}
            showsVerticalScrollIndicator={false}
            scrollEnabled={false}
            bounces={false}
            overScrollMode="never"
          >
            {tasks.map((task) => (
              <TouchableOpacity
                key={task.id}
                style={[
                  styles.issueRow,
                  { borderBottomColor: colors.border },
                  detailTask?.id === task.id && styles.issueRowSelected,
                ]}
                onPress={() => setDetailTask(task)}
                activeOpacity={0.7}
              >
                <View style={styles.issueNameContainer}>
                  <View style={styles.issueDot} />
                  <Text style={[styles.issueName, { color: colors.text }]} numberOfLines={1}>
                    {task.title}
                  </Text>
                </View>
                <Text style={[styles.issueDuration, { color: colors.muted }]}>
                  {formatDuration(task)}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>

          {/* Add Task Button */}
          <TouchableOpacity
            style={[styles.addTaskButton, { borderTopColor: colors.border }]}
            onPress={openAddModal}
          >
            <Plus size={16} color="#1F2937" strokeWidth={2} />
            <Text style={styles.addTaskButtonText}>Add Task</Text>
          </TouchableOpacity>
        </View>

        {/* Right panel - Timeline */}
        <View style={styles.rightPanel}>
          {/* Timeline header */}
          <View style={[styles.timelineHeader, { borderBottomColor: colors.border }]}>
            {/* Today marker line - rendered outside ScrollView */}
            {todayPosition !== null && (
              <Animated.View
                style={[
                  styles.todayMarkerHeader,
                  {
                    transform: [{
                      translateX: Animated.subtract(
                        new Animated.Value(todayPosition),
                        scrollX
                      )
                    }]
                  }
                ]}
              />
            )}
            {/* Month labels with Today button */}
            <Animated.ScrollView
              ref={horizontalScrollRef}
              horizontal
              showsHorizontalScrollIndicator={false}
              scrollEventThrottle={16}
              bounces={false}
              overScrollMode="never"
              scrollEnabled={false}
              onScroll={Animated.event(
                [{ nativeEvent: { contentOffset: { x: scrollX } } }],
                { useNativeDriver: true }
              )}
            >
              <View style={[styles.monthLabelsWrapper, { width: timePeriods.length * columnWidth }]}>
                {/* Today button positioned above the today marker */}
                <View style={styles.todayButtonRow}>
                  <Text style={[styles.yearLabel, { color: colors.muted }]}>{viewYear}</Text>
                  {todayPosition !== null && (
                    <TouchableOpacity
                      style={[styles.todayButton, { position: 'absolute', left: todayPosition - 30 }]}
                      onPress={scrollToToday}
                    >
                      <Text style={styles.todayButtonText}>Today</Text>
                    </TouchableOpacity>
                  )}
                </View>
                {/* Period labels */}
                <View style={styles.monthLabelsContainer}>
                  {timePeriods.map((period, index) => (
                    <View
                      key={`${period.date.getTime()}`}
                      style={[
                        styles.monthLabel,
                        { width: columnWidth },
                      ]}
                    >
                      <Text
                        style={[
                          styles.monthLabelText,
                          { color: colors.muted },
                          isCurrentPeriod(period.date) && { color: '#3B82F6', fontWeight: '600' },
                        ]}
                      >
                        {period.label}
                      </Text>
                      {viewMode !== 'month' && period.subLabel && (
                        <Text
                          style={[
                            styles.periodSubLabel,
                            { color: colors.muted },
                          ]}
                        >
                          {period.subLabel}
                        </Text>
                      )}
                    </View>
                  ))}
                </View>
              </View>
            </Animated.ScrollView>
          </View>

          {/* Timeline body */}
          <ScrollView
            ref={bodyHorizontalScrollRef}
            horizontal
            showsHorizontalScrollIndicator={false}
            scrollEventThrottle={16}
            bounces={false}
            overScrollMode="never"
            style={[styles.timelineBodyScroll, { borderTopColor: colors.border }]}
            onScroll={(e) => {
              // Sync header scroll
              horizontalScrollRef.current?.scrollTo({
                x: e.nativeEvent.contentOffset.x,
                animated: false,
              });
            }}
          >
            <View style={[styles.timelineBody, { width: timePeriods.length * columnWidth }]}>
              {/* Grid lines */}
              <View style={styles.gridContainer}>
                {timePeriods.map((period, index) => (
                  <View
                    key={`grid-${period.date.getTime()}`}
                    style={[
                      styles.gridLine,
                      {
                        left: index * columnWidth,
                        width: columnWidth,
                        borderRightColor: colors.border,
                        backgroundColor: isCurrentPeriod(period.date)
                          ? 'rgba(59, 130, 246, 0.05)'
                          : 'transparent',
                      },
                    ]}
                  />
                ))}
              </View>

              {/* Today marker */}
              {todayPosition !== null && (
                <View style={[styles.todayMarker, { left: todayPosition }]} />
              )}

              {/* Task bars */}
              <Animated.ScrollView
                ref={timelineBodyScrollRef}
                showsVerticalScrollIndicator={false}
                scrollEventThrottle={16}
                bounces={false}
                overScrollMode="never"
                onScroll={Animated.event(
                  [{ nativeEvent: { contentOffset: { y: scrollY } } }],
                  { useNativeDriver: false }
                )}
                contentContainerStyle={styles.taskBarsContainer}
              >
                {tasks.map((task, index) => {
                  const bar = getTaskBar(task);

                  return (
                    <View key={task.id} style={[styles.taskBarRow, { height: 40 }]}>
                      {bar && (
                        <TouchableOpacity
                          style={[
                            styles.taskBar,
                            {
                              left: bar.left,
                              width: bar.width,
                              backgroundColor: 'rgba(167, 139, 250, 0.7)',
                            },
                          ]}
                          activeOpacity={0.8}
                          onPress={() => openTaskModal(task)}
                        >
                          <Text style={styles.taskBarText} numberOfLines={1}>
                            {task.title}
                          </Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  );
                })}
              </Animated.ScrollView>
            </View>
          </ScrollView>
        </View>
        </View>

        {/* Detail Panel */}
        {detailTask && (
          <DetailPanel
            item={{
              id: detailTask.id,
              title: detailTask.title,
              description: detailTask.description,
              status: detailTask.status,
              priority: detailTask.priority,
              startDate: detailTask.startDate,
              dueDate: detailTask.dueDate,
              assigneeName: detailTask.assigneeName,
              progress: detailTask.progress,
            }}
            workspaceName="Project"
            onClose={() => setDetailTask(null)}
            onEditPress={() => openTaskModal(detailTask)}
            editButtonLabel="Edit Dates"
            showCheckbox={true}
          />
        )}
      </View>

      {/* Task Edit Modal */}
      <Modal
        visible={selectedTask !== null}
        transparent
        animationType="fade"
        onRequestClose={closeTaskModal}
      >
        <Pressable style={styles.modalOverlay} onPress={closeTaskModal}>
          <Pressable style={styles.modalContent} onPress={(e) => e.stopPropagation()}>
            {/* Modal Header */}
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: colors.text }]} numberOfLines={1}>
                {selectedTask?.title}
              </Text>
              <TouchableOpacity onPress={closeTaskModal} style={styles.modalCloseButton}>
                <X size={20} color={colors.muted} />
              </TouchableOpacity>
            </View>

            {/* Duration display */}
            <View style={[styles.durationDisplay, { backgroundColor: colors.background }]}>
              <Calendar size={16} color={colors.muted} />
              <Text style={[styles.durationText, { color: colors.muted }]}>
                {selectedTask && formatDuration(selectedTask)}
              </Text>
            </View>

            {/* Start Date */}
            <View style={styles.dateSection}>
              <Text style={[styles.dateLabel, { color: '#6B7280' }]}>Start Date</Text>
              <View style={styles.dateControls}>
                <TouchableOpacity
                  style={styles.dateArrowButton}
                  onPress={() => adjustDate('start', -7)}
                >
                  <ChevronLeft size={16} color="#374151" />
                  <ChevronLeft size={16} color="#374151" style={{ marginLeft: -10 }} />
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.dateArrowButton}
                  onPress={() => adjustDate('start', -1)}
                >
                  <ChevronLeft size={18} color="#374151" />
                </TouchableOpacity>
                <View style={styles.dateDisplay}>
                  <Text style={[styles.dateText, { color: '#1F2937' }]}>
                    {formatDate(editStartDate)}
                  </Text>
                </View>
                <TouchableOpacity
                  style={styles.dateArrowButton}
                  onPress={() => adjustDate('start', 1)}
                >
                  <ChevronRight size={18} color="#374151" />
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.dateArrowButton}
                  onPress={() => adjustDate('start', 7)}
                >
                  <ChevronRight size={16} color="#374151" />
                  <ChevronRight size={16} color="#374151" style={{ marginLeft: -10 }} />
                </TouchableOpacity>
              </View>
            </View>

            {/* End Date */}
            <View style={styles.dateSection}>
              <Text style={[styles.dateLabel, { color: '#6B7280' }]}>End Date</Text>
              <View style={styles.dateControls}>
                <TouchableOpacity
                  style={styles.dateArrowButton}
                  onPress={() => adjustDate('end', -7)}
                >
                  <ChevronLeft size={16} color="#374151" />
                  <ChevronLeft size={16} color="#374151" style={{ marginLeft: -10 }} />
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.dateArrowButton}
                  onPress={() => adjustDate('end', -1)}
                >
                  <ChevronLeft size={18} color="#374151" />
                </TouchableOpacity>
                <View style={styles.dateDisplay}>
                  <Text style={[styles.dateText, { color: '#1F2937' }]}>
                    {formatDate(editEndDate)}
                  </Text>
                </View>
                <TouchableOpacity
                  style={styles.dateArrowButton}
                  onPress={() => adjustDate('end', 1)}
                >
                  <ChevronRight size={18} color="#374151" />
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.dateArrowButton}
                  onPress={() => adjustDate('end', 7)}
                >
                  <ChevronRight size={16} color="#374151" />
                  <ChevronRight size={16} color="#374151" style={{ marginLeft: -10 }} />
                </TouchableOpacity>
              </View>
            </View>

            {/* Action Buttons */}
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={styles.cancelButton}
                onPress={closeTaskModal}
              >
                <Text style={[styles.cancelButtonText, { color: '#374151' }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.saveButton, { opacity: saving ? 0.7 : 1 }]}
                onPress={saveTaskDates}
                disabled={saving}
              >
                <Text style={styles.saveButtonText}>
                  {saving ? 'Saving...' : 'Save Changes'}
                </Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Add Task Modal */}
      <Modal
        visible={showAddModal}
        transparent
        animationType="fade"
        onRequestClose={closeAddModal}
      >
        <Pressable style={styles.modalOverlay} onPress={closeAddModal}>
          <Pressable style={styles.modalContent} onPress={(e) => e.stopPropagation()}>
            {/* Modal Header */}
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: '#1F2937' }]}>
                New Task
              </Text>
              <TouchableOpacity onPress={closeAddModal} style={styles.modalCloseButton}>
                <X size={20} color="#6B7280" />
              </TouchableOpacity>
            </View>

            {/* Task Title Input */}
            <View style={styles.inputSection}>
              <Text style={[styles.dateLabel, { color: '#6B7280' }]}>Task Title</Text>
              <TextInput
                style={styles.textInput}
                value={newTaskTitle}
                onChangeText={setNewTaskTitle}
                placeholder="Enter task title..."
                placeholderTextColor="#9CA3AF"
              />
            </View>

            {/* Start Date */}
            <View style={styles.dateSection}>
              <Text style={[styles.dateLabel, { color: '#6B7280' }]}>Start Date</Text>
              <View style={styles.dateControls}>
                <TouchableOpacity
                  style={styles.dateArrowButton}
                  onPress={() => adjustNewTaskDate('start', -7)}
                >
                  <ChevronLeft size={16} color="#374151" />
                  <ChevronLeft size={16} color="#374151" style={{ marginLeft: -10 }} />
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.dateArrowButton}
                  onPress={() => adjustNewTaskDate('start', -1)}
                >
                  <ChevronLeft size={18} color="#374151" />
                </TouchableOpacity>
                <View style={styles.dateDisplay}>
                  <Text style={[styles.dateText, { color: '#1F2937' }]}>
                    {formatDate(newTaskStartDate)}
                  </Text>
                </View>
                <TouchableOpacity
                  style={styles.dateArrowButton}
                  onPress={() => adjustNewTaskDate('start', 1)}
                >
                  <ChevronRight size={18} color="#374151" />
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.dateArrowButton}
                  onPress={() => adjustNewTaskDate('start', 7)}
                >
                  <ChevronRight size={16} color="#374151" />
                  <ChevronRight size={16} color="#374151" style={{ marginLeft: -10 }} />
                </TouchableOpacity>
              </View>
            </View>

            {/* End Date */}
            <View style={styles.dateSection}>
              <Text style={[styles.dateLabel, { color: '#6B7280' }]}>End Date</Text>
              <View style={styles.dateControls}>
                <TouchableOpacity
                  style={styles.dateArrowButton}
                  onPress={() => adjustNewTaskDate('end', -7)}
                >
                  <ChevronLeft size={16} color="#374151" />
                  <ChevronLeft size={16} color="#374151" style={{ marginLeft: -10 }} />
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.dateArrowButton}
                  onPress={() => adjustNewTaskDate('end', -1)}
                >
                  <ChevronLeft size={18} color="#374151" />
                </TouchableOpacity>
                <View style={styles.dateDisplay}>
                  <Text style={[styles.dateText, { color: '#1F2937' }]}>
                    {formatDate(newTaskEndDate)}
                  </Text>
                </View>
                <TouchableOpacity
                  style={styles.dateArrowButton}
                  onPress={() => adjustNewTaskDate('end', 1)}
                >
                  <ChevronRight size={18} color="#374151" />
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.dateArrowButton}
                  onPress={() => adjustNewTaskDate('end', 7)}
                >
                  <ChevronRight size={16} color="#374151" />
                  <ChevronRight size={16} color="#374151" style={{ marginLeft: -10 }} />
                </TouchableOpacity>
              </View>
            </View>

            {/* Action Buttons */}
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={styles.cancelButton}
                onPress={closeAddModal}
              >
                <Text style={[styles.cancelButtonText, { color: '#374151' }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.saveButton, { opacity: creating || !newTaskTitle.trim() ? 0.5 : 1 }]}
                onPress={createTask}
                disabled={creating || !newTaskTitle.trim()}
              >
                <Text style={styles.saveButtonText}>
                  {creating ? 'Creating...' : 'Create Task'}
                </Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  centered: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  toolbar: {
    height: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    backgroundColor: '#FFFFFF',
  },
  viewModeToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  viewModeButton: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    backgroundColor: '#FFFFFF',
  },
  viewModeButtonActive: {
    backgroundColor: '#1F2937',
    borderColor: '#1F2937',
  },
  viewModeButtonText: {
    fontSize: 13,
    fontWeight: '500',
    color: '#6B7280',
  },
  viewModeButtonTextActive: {
    color: '#FFFFFF',
  },
  zoomControls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  zoomButton: {
    width: 28,
    height: 28,
    borderRadius: 6,
    justifyContent: 'center',
    alignItems: 'center',
  },
  zoomText: {
    fontSize: 13,
    fontWeight: '500',
    color: '#374151',
    minWidth: 44,
    textAlign: 'center',
  },
  mainContent: {
    flex: 1,
    flexDirection: 'row',
  },
  leftPanel: {
    width: LEFT_PANEL_WIDTH,
    borderRightWidth: 1,
    backgroundColor: '#FFFFFF',
    zIndex: 200,
    position: 'relative',
  },
  leftPanelHeader: {
    height: 61,
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    paddingLeft: 16,
    paddingRight: 12,
    paddingBottom: 8,
    borderBottomWidth: 1,
  },
  durationColumn: {
    alignItems: 'flex-end',
    gap: 4,
  },
  issuesLabel: {
    fontSize: 13,
    fontWeight: '500',
  },
  addButton: {
    width: 20,
    height: 20,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: -4,
  },
  durationLabel: {
    fontSize: 13,
    fontWeight: '500',
  },
  addTaskButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 14,
    borderTopWidth: 1,
    backgroundColor: '#FFFFFF',
  },
  addTaskButtonText: {
    fontSize: 14,
    fontWeight: '500',
    color: '#1F2937',
  },
  issueRow: {
    height: 40,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: 16,
    paddingRight: 12,
    borderBottomWidth: 1,
  },
  issueNameContainer: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginRight: 8,
  },
  issueDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#3B82F6',
  },
  issueName: {
    fontSize: 13,
    fontWeight: '400',
    flex: 1,
  },
  issueDuration: {
    fontSize: 12,
    textAlign: 'right',
  },
  rightPanel: {
    flex: 1,
    position: 'relative',
  },
  timelineHeader: {
    height: 60,
    backgroundColor: '#FFFFFF',
    overflow: 'visible',
    zIndex: 100,
    position: 'relative',
  },
  timelineBodyScroll: {
    borderTopWidth: 1,
    zIndex: 1,
    position: 'relative',
  },
  monthLabelsWrapper: {
    flexDirection: 'column',
    overflow: 'visible',
  },
  todayButtonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 24,
    position: 'relative',
    overflow: 'visible',
    zIndex: 1000,
  },
  todayButton: {
    backgroundColor: '#3B82F6',
    paddingHorizontal: 14,
    paddingVertical: 3,
    borderRadius: 4,
  },
  todayButtonText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '600',
  },
  yearLabel: {
    fontSize: 13,
    fontWeight: '500',
    marginLeft: 8,
  },
  monthLabelsContainer: {
    flexDirection: 'row',
    height: 36,
    alignItems: 'flex-end',
    paddingBottom: 8,
  },
  monthLabel: {
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  monthLabelText: {
    fontSize: 12,
    fontWeight: '500',
  },
  periodSubLabel: {
    fontSize: 9,
    marginTop: 1,
  },
  timelineBody: {
    flex: 1,
    position: 'relative',
  },
  gridContainer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
  },
  gridLine: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    borderRightWidth: 1,
  },
  todayMarker: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 2,
    backgroundColor: '#3B82F6',
    zIndex: 100,
  },
  todayMarkerHeader: {
    position: 'absolute',
    top: 24,
    bottom: -2,
    left: 0,
    width: 2,
    backgroundColor: '#3B82F6',
    zIndex: 1000,
    elevation: 1000,
  },
  taskBarsContainer: {
    paddingTop: 4,
  },
  taskBarRow: {
    position: 'relative',
    justifyContent: 'center',
  },
  taskBar: {
    position: 'absolute',
    height: 30,
    borderRadius: 7,
    justifyContent: 'center',
    paddingHorizontal: 8,
    top: 0.5,
  },
  taskBarText: {
    color: '#1F2937',
    fontSize: 11,
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
  modalContent: {
    width: '90%',
    maxWidth: 400,
    borderRadius: 16,
    padding: 24,
    backgroundColor: '#FFFFFF',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.25,
    shadowRadius: 24,
    elevation: 10,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '600',
    flex: 1,
    marginRight: 12,
  },
  modalCloseButton: {
    width: 32,
    height: 32,
    justifyContent: 'center',
    alignItems: 'center',
  },
  durationDisplay: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 8,
    marginBottom: 20,
    backgroundColor: '#F9FAFB',
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  durationText: {
    fontSize: 14,
    fontWeight: '500',
  },
  dateSection: {
    marginBottom: 20,
  },
  inputSection: {
    marginBottom: 20,
  },
  textInput: {
    height: 44,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    backgroundColor: '#F9FAFB',
    paddingHorizontal: 14,
    fontSize: 15,
    color: '#1F2937',
  },
  dateLabel: {
    fontSize: 13,
    fontWeight: '500',
    marginBottom: 8,
  },
  dateControls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  dateArrowButton: {
    width: 36,
    height: 36,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
    flexDirection: 'row',
    backgroundColor: '#F3F4F6',
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  dateDisplay: {
    flex: 1,
    height: 40,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#F9FAFB',
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  dateText: {
    fontSize: 14,
    fontWeight: '500',
  },
  modalActions: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 8,
  },
  cancelButton: {
    flex: 1,
    height: 44,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    backgroundColor: '#FFFFFF',
    justifyContent: 'center',
    alignItems: 'center',
  },
  cancelButtonText: {
    fontSize: 14,
    fontWeight: '600',
  },
  saveButton: {
    flex: 1,
    height: 44,
    borderRadius: 8,
    backgroundColor: '#3B82F6',
    justifyContent: 'center',
    alignItems: 'center',
  },
  saveButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  // Gantt content wrapper
  ganttContent: {
    flex: 1,
    flexDirection: 'row',
  },
  ganttContentWithPanel: {
    flex: 0.65,
  },
  // Issue row selected state
  issueRowSelected: {
    backgroundColor: '#F3F4F6',
  },
});
