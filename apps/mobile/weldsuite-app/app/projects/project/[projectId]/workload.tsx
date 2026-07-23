import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  StyleSheet,
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  Dimensions,
} from 'react-native';
import { useTheme } from '@/contexts/ThemeContext';
import { useToast } from '@/contexts/ToastContext';
import { useLocalSearchParams } from 'expo-router';
import {
  Users,
  ChevronLeft,
  ChevronRight,
  Calendar,
  Clock,
  CheckCircle2,
  AlertCircle,
  TrendingUp,
  AlertTriangle,
} from 'lucide-react-native';
import api, { ProjectTask, ProjectMember } from '@/services/api';

// Workload types from API
interface WorkloadMemberTask {
  id: string;
  title: string;
  status: string;
  priority: string;
  estimatedHours: number;
  actualHours: number;
  dueDate?: string;
}

interface WorkloadMember {
  userId: string;
  name: string;
  email?: string;
  avatar?: string;
  initials: string;
  role: string;
  capacity: number;
  allocated: number;
  actual: number;
  tasks: WorkloadMemberTask[];
  status: 'overallocated' | 'near-capacity' | 'available';
  utilizationPercent: number;
}

interface WorkloadOverview {
  totalTasks: number;
  completedTasks: number;
  inProgressTasks: number;
  todoTasks: number;
  overdueTasks: number;
  totalEstimatedHours: number;
  totalActualHours: number;
  totalCapacity: number;
  totalAllocated: number;
  utilization: number;
  overallocatedCount: number;
}

interface ProjectWorkloadData {
  projectId: string;
  projectName: string;
  overview: WorkloadOverview;
  members: WorkloadMember[];
}

const { width: screenWidth } = Dimensions.get('window');
const DAY_WIDTH = 50;
const MEMBER_ROW_HEIGHT = 60;
const HEADER_HEIGHT = 80;
const NAME_COLUMN_WIDTH = 180;

interface TaskWithDates extends ProjectTask {
  startDateParsed?: Date;
  endDateParsed?: Date;
}

const getWeekDates = (startDate: Date, days: number): Date[] => {
  const dates: Date[] = [];
  const current = new Date(startDate);
  for (let i = 0; i < days; i++) {
    dates.push(new Date(current));
    current.setDate(current.getDate() + 1);
  }
  return dates;
};

const formatDayHeader = (date: Date): string => {
  return date.toLocaleDateString('en-US', { weekday: 'short' }).charAt(0);
};

const formatDayNumber = (date: Date): string => {
  return date.getDate().toString();
};

const isToday = (date: Date): boolean => {
  const today = new Date();
  return date.toDateString() === today.toDateString();
};

const isWeekend = (date: Date): boolean => {
  const day = date.getDay();
  return day === 0 || day === 6;
};

const getCapacityColor = (hours: number): string => {
  if (hours === 0) return '#6B7280';
  if (hours <= 6) return '#10B981'; // Green - under capacity
  if (hours <= 8) return '#F59E0B'; // Yellow - at capacity
  return '#EF4444'; // Red - over capacity
};

const getInitials = (name: string): string => {
  return name
    .split(' ')
    .map(n => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
};

export default function ProjectWorkloadScreen() {
  const { colors } = useTheme();
  const toast = useToast();
  const { projectId } = useLocalSearchParams();
  const [workloadData, setWorkloadData] = useState<ProjectWorkloadData | null>(null);
  const [tasks, setTasks] = useState<TaskWithDates[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showOverview, setShowOverview] = useState(true);
  const [startDate, setStartDate] = useState<Date>(() => {
    const today = new Date();
    today.setDate(today.getDate() - today.getDay()); // Start of current week
    return today;
  });
  const scrollViewRef = useRef<ScrollView>(null);

  const daysToShow = 14; // Two weeks
  const dates = useMemo(() => getWeekDates(startDate, daysToShow), [startDate]);

  const loadData = useCallback(async () => {
    if (!projectId) return;

    try {
      setLoading(true);

      // Fetch workload data and tasks in parallel
      const [workloadRes, tasksRes] = await Promise.all([
        api.getProjectWorkload(projectId as string),
        api.getProjectTasksList(projectId as string),
      ]);

      if (workloadRes.success && workloadRes.data) {
        setWorkloadData(workloadRes.data);
      } else {
        console.warn('[Workload] API returned:', workloadRes);
      }

      if (tasksRes.success && tasksRes.data) {
        // Handle both array and paginated response structures
        const taskItems = Array.isArray(tasksRes.data)
          ? tasksRes.data
          : (tasksRes.data as any).items || [];

        // Parse dates and filter tasks with valid dates
        const parsedTasks = taskItems.map((task: ProjectTask) => ({
          ...task,
          startDateParsed: task.startDate ? new Date(task.startDate) : undefined,
          endDateParsed: task.dueDate ? new Date(task.dueDate) : undefined,
        }));
        setTasks(parsedTasks);
      } else {
        // Reset tasks if no data
        setTasks([]);
      }
    } catch (error) {
      console.error('Error loading workload data:', error);
      toast.error('Failed to load workload data');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [projectId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleRefresh = () => {
    setRefreshing(true);
    loadData();
  };

  const navigateWeek = (direction: 'prev' | 'next') => {
    const newDate = new Date(startDate);
    newDate.setDate(newDate.getDate() + (direction === 'next' ? 7 : -7));
    setStartDate(newDate);
  };

  const goToToday = () => {
    const today = new Date();
    today.setDate(today.getDate() - today.getDay());
    setStartDate(today);
  };

  // Get members from workload data
  const members = useMemo(() => workloadData?.members || [], [workloadData]);

  // Calculate hours per member per day
  const memberWorkload = useMemo(() => {
    const workload: Record<string, Record<string, { hours: number; tasks: TaskWithDates[] }>> = {};

    members.forEach(member => {
      if (member.userId) {
        workload[member.userId] = {};
        dates.forEach(date => {
          workload[member.userId][date.toDateString()] = { hours: 0, tasks: [] };
        });
      }
    });

    tasks.forEach(task => {
      if (!task.assigneeId || !task.startDateParsed || !task.endDateParsed) return;
      if (!workload[task.assigneeId]) return;

      const taskDays = Math.ceil(
        (task.endDateParsed.getTime() - task.startDateParsed.getTime()) / (1000 * 60 * 60 * 24)
      ) + 1;
      const hoursPerDay = (task.estimatedHours || 8) / Math.max(taskDays, 1);

      dates.forEach(date => {
        if (date >= task.startDateParsed! && date <= task.endDateParsed!) {
          const key = date.toDateString();
          if (workload[task.assigneeId!][key]) {
            workload[task.assigneeId!][key].hours += hoursPerDay;
            workload[task.assigneeId!][key].tasks.push(task);
          }
        }
      });
    });

    return workload;
  }, [members, tasks, dates]);

  // Get status color for utilization
  const getUtilizationColor = (status: WorkloadMember['status']): string => {
    switch (status) {
      case 'overallocated': return '#EF4444';
      case 'near-capacity': return '#F59E0B';
      case 'available': return '#10B981';
      default: return '#6B7280';
    }
  };

  // Get status badge text
  const getStatusText = (status: WorkloadMember['status']): string => {
    switch (status) {
      case 'overallocated': return 'Over';
      case 'near-capacity': return 'Busy';
      case 'available': return 'Free';
      default: return '';
    }
  };

  // Get tasks that span the visible date range for each member
  const getMemberTasks = (memberId: string): TaskWithDates[] => {
    return tasks.filter(task => {
      if (task.assigneeId !== memberId) return false;
      if (!task.startDateParsed || !task.endDateParsed) return false;

      const rangeStart = dates[0];
      const rangeEnd = dates[dates.length - 1];

      return task.startDateParsed <= rangeEnd && task.endDateParsed >= rangeStart;
    });
  };

  const getTaskBarStyle = (task: TaskWithDates) => {
    if (!task.startDateParsed || !task.endDateParsed) return null;

    const rangeStart = dates[0];
    const rangeEnd = dates[dates.length - 1];

    const taskStart = task.startDateParsed < rangeStart ? rangeStart : task.startDateParsed;
    const taskEnd = task.endDateParsed > rangeEnd ? rangeEnd : task.endDateParsed;

    const startOffset = Math.floor(
      (taskStart.getTime() - rangeStart.getTime()) / (1000 * 60 * 60 * 24)
    );
    const duration = Math.ceil(
      (taskEnd.getTime() - taskStart.getTime()) / (1000 * 60 * 60 * 24)
    ) + 1;

    return {
      left: startOffset * DAY_WIDTH + 4,
      width: duration * DAY_WIDTH - 8,
    };
  };

  const getStatusColor = (status: string): string => {
    switch (status) {
      case 'done': return '#10B981';
      case 'in_progress': return '#3B82F6';
      case 'in_review': return '#8B5CF6';
      case 'todo': return '#6B7280';
      default: return '#6B7280';
    }
  };

  if (loading && !refreshing) {
    return (
      <View style={[styles.centerContainer, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.text} />
        <Text style={[styles.loadingText, { color: colors.muted }]}>Loading workload...</Text>
      </View>
    );
  }

  const overview = workloadData?.overview;

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Overview Statistics */}
      {showOverview && overview && (
        <View style={[styles.overviewContainer, { borderBottomColor: colors.divider }]}>
          <View style={styles.overviewRow}>
            <View style={[styles.statCard, { backgroundColor: colors.card }]}>
              <View style={[styles.statIcon, { backgroundColor: '#3B82F620' }]}>
                <CheckCircle2 size={16} color="#3B82F6" strokeWidth={2} />
              </View>
              <Text style={[styles.statValue, { color: colors.text }]}>
                {overview.completedTasks}/{overview.totalTasks}
              </Text>
              <Text style={[styles.statLabel, { color: colors.muted }]}>Tasks</Text>
            </View>

            <View style={[styles.statCard, { backgroundColor: colors.card }]}>
              <View style={[styles.statIcon, { backgroundColor: '#10B98120' }]}>
                <Clock size={16} color="#10B981" strokeWidth={2} />
              </View>
              <Text style={[styles.statValue, { color: colors.text }]}>
                {Math.round(overview.totalActualHours)}h
              </Text>
              <Text style={[styles.statLabel, { color: colors.muted }]}>Logged</Text>
            </View>

            <View style={[styles.statCard, { backgroundColor: colors.card }]}>
              <View style={[styles.statIcon, { backgroundColor: '#F59E0B20' }]}>
                <TrendingUp size={16} color="#F59E0B" strokeWidth={2} />
              </View>
              <Text style={[styles.statValue, { color: colors.text }]}>
                {Math.round(overview.utilization)}%
              </Text>
              <Text style={[styles.statLabel, { color: colors.muted }]}>Utilization</Text>
            </View>

            <View style={[styles.statCard, { backgroundColor: colors.card }]}>
              <View style={[styles.statIcon, { backgroundColor: overview.overallocatedCount > 0 ? '#EF444420' : '#6B728020' }]}>
                <AlertTriangle size={16} color={overview.overallocatedCount > 0 ? '#EF4444' : '#6B7280'} strokeWidth={2} />
              </View>
              <Text style={[styles.statValue, { color: overview.overallocatedCount > 0 ? '#EF4444' : colors.text }]}>
                {overview.overallocatedCount}
              </Text>
              <Text style={[styles.statLabel, { color: colors.muted }]}>Overloaded</Text>
            </View>
          </View>

          {overview.overdueTasks > 0 && (
            <View style={[styles.alertBanner, { backgroundColor: '#EF444415' }]}>
              <AlertCircle size={14} color="#EF4444" strokeWidth={2} />
              <Text style={styles.alertText}>
                {overview.overdueTasks} overdue task{overview.overdueTasks > 1 ? 's' : ''}
              </Text>
            </View>
          )}
        </View>
      )}

      {/* Header Controls */}
      <View style={[styles.controls, { borderBottomColor: colors.divider }]}>
        <View style={styles.dateNavigation}>
          <TouchableOpacity
            style={[styles.navButton, { backgroundColor: colors.card }]}
            onPress={() => navigateWeek('prev')}
          >
            <ChevronLeft size={20} color={colors.text} strokeWidth={2} />
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.todayButton, { backgroundColor: colors.card }]}
            onPress={goToToday}
          >
            <Calendar size={16} color={colors.text} strokeWidth={2} />
            <Text style={[styles.todayText, { color: colors.text }]}>Today</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.navButton, { backgroundColor: colors.card }]}
            onPress={() => navigateWeek('next')}
          >
            <ChevronRight size={20} color={colors.text} strokeWidth={2} />
          </TouchableOpacity>
        </View>
        <TouchableOpacity onPress={() => setShowOverview(!showOverview)}>
          <Text style={[styles.dateRange, { color: colors.muted }]}>
            {dates[0].toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} - {dates[dates.length - 1].toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Workload Grid */}
      <View style={styles.gridContainer}>
        {/* Fixed member names column */}
        <View style={[styles.membersColumn, { backgroundColor: colors.background }]}>
          {/* Empty header cell */}
          <View style={[styles.headerCell, { height: HEADER_HEIGHT, borderBottomColor: colors.divider }]}>
            <Users size={20} color={colors.muted} strokeWidth={2} />
            <Text style={[styles.teamLabel, { color: colors.muted }]}>Team</Text>
          </View>

          {/* Member rows */}
          {members.map(member => (
            <View
              key={member.userId}
              style={[
                styles.memberRow,
                { height: MEMBER_ROW_HEIGHT, borderBottomColor: colors.divider },
              ]}
            >
              <View style={[styles.memberAvatar, { backgroundColor: getUtilizationColor(member.status) + '20' }]}>
                <Text style={[styles.avatarText, { color: getUtilizationColor(member.status) }]}>
                  {member.initials || getInitials(member.name || 'U')}
                </Text>
              </View>
              <View style={styles.memberInfo}>
                <View style={styles.memberNameRow}>
                  <Text style={[styles.memberName, { color: colors.text }]} numberOfLines={1}>
                    {member.name || 'Unknown'}
                  </Text>
                  <View style={[styles.statusBadge, { backgroundColor: getUtilizationColor(member.status) + '20' }]}>
                    <Text style={[styles.statusBadgeText, { color: getUtilizationColor(member.status) }]}>
                      {Math.round(member.utilizationPercent)}%
                    </Text>
                  </View>
                </View>
                <Text style={[styles.memberRole, { color: colors.muted }]}>
                  {member.role} · {member.allocated}h / {member.capacity}h
                </Text>
              </View>
            </View>
          ))}
        </View>

        {/* Scrollable timeline */}
        <ScrollView
          ref={scrollViewRef}
          horizontal
          showsHorizontalScrollIndicator={false}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
          }
        >
          <View>
            {/* Date headers */}
            <View style={[styles.dateHeaders, { height: HEADER_HEIGHT, borderBottomColor: colors.divider }]}>
              {dates.map((date, index) => (
                <View
                  key={index}
                  style={[
                    styles.dateHeader,
                    { width: DAY_WIDTH },
                    isWeekend(date) && { backgroundColor: colors.card + '40' },
                    isToday(date) && styles.todayHeader,
                  ]}
                >
                  <Text style={[styles.dayLabel, { color: colors.muted }]}>
                    {formatDayHeader(date)}
                  </Text>
                  <View style={[
                    styles.dayNumber,
                    isToday(date) && styles.todayNumber,
                  ]}>
                    <Text style={[
                      styles.dayNumberText,
                      { color: isToday(date) ? '#FFFFFF' : colors.text },
                    ]}>
                      {formatDayNumber(date)}
                    </Text>
                  </View>
                </View>
              ))}
            </View>

            {/* Member task rows */}
            {members.map(member => {
              const memberTasks = getMemberTasks(member.userId);
              const userId = member.userId;

              return (
                <View
                  key={member.userId}
                  style={[styles.taskRow, { height: MEMBER_ROW_HEIGHT, borderBottomColor: colors.divider }]}
                >
                  {/* Day cells with capacity indicators */}
                  {dates.map((date, index) => {
                    const dayData = memberWorkload[userId]?.[date.toDateString()];
                    const hours = dayData?.hours || 0;
                    const capacityColor = getCapacityColor(hours);

                    return (
                      <View
                        key={index}
                        style={[
                          styles.dayCell,
                          { width: DAY_WIDTH, borderRightColor: colors.divider },
                          isWeekend(date) && { backgroundColor: colors.card + '40' },
                        ]}
                      >
                        {hours > 0 && (
                          <View style={[styles.capacityDot, { backgroundColor: capacityColor }]} />
                        )}
                      </View>
                    );
                  })}

                  {/* Task bars overlay */}
                  <View style={styles.taskBarsContainer}>
                    {memberTasks.slice(0, 2).map((task, index) => {
                      const barStyle = getTaskBarStyle(task);
                      if (!barStyle) return null;

                      return (
                        <View
                          key={task.id}
                          style={[
                            styles.taskBar,
                            {
                              left: barStyle.left,
                              width: barStyle.width,
                              top: 8 + index * 22,
                              backgroundColor: getStatusColor(task.status) + '20',
                              borderLeftColor: getStatusColor(task.status),
                            },
                          ]}
                        >
                          <Text
                            style={[styles.taskBarText, { color: getStatusColor(task.status) }]}
                            numberOfLines={1}
                          >
                            {task.title}
                          </Text>
                        </View>
                      );
                    })}
                  </View>
                </View>
              );
            })}
          </View>
        </ScrollView>
      </View>

      {/* Legend */}
      <View style={[styles.legend, { backgroundColor: colors.card, borderTopColor: colors.divider }]}>
        <View style={styles.legendItem}>
          <View style={[styles.legendDot, { backgroundColor: '#10B981' }]} />
          <Text style={[styles.legendText, { color: colors.muted }]}>Under capacity</Text>
        </View>
        <View style={styles.legendItem}>
          <View style={[styles.legendDot, { backgroundColor: '#F59E0B' }]} />
          <Text style={[styles.legendText, { color: colors.muted }]}>At capacity</Text>
        </View>
        <View style={styles.legendItem}>
          <View style={[styles.legendDot, { backgroundColor: '#EF4444' }]} />
          <Text style={[styles.legendText, { color: colors.muted }]}>Over capacity</Text>
        </View>
      </View>
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
  loadingText: {
    marginTop: 12,
    fontSize: 14,
  },
  overviewContainer: {
    padding: 12,
    borderBottomWidth: 1,
  },
  overviewRow: {
    flexDirection: 'row',
    gap: 8,
  },
  statCard: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 6,
    borderRadius: 10,
    gap: 4,
  },
  statIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 2,
  },
  statValue: {
    fontSize: 16,
    fontWeight: '700',
  },
  statLabel: {
    fontSize: 10,
    fontWeight: '500',
    textTransform: 'uppercase',
  },
  alertBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  alertText: {
    fontSize: 13,
    fontWeight: '500',
    color: '#EF4444',
  },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 12,
    borderBottomWidth: 1,
  },
  dateNavigation: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  navButton: {
    width: 36,
    height: 36,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  todayButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    height: 36,
    borderRadius: 8,
  },
  todayText: {
    fontSize: 14,
    fontWeight: '500',
  },
  dateRange: {
    fontSize: 13,
  },
  gridContainer: {
    flex: 1,
    flexDirection: 'row',
  },
  membersColumn: {
    width: NAME_COLUMN_WIDTH,
    borderRightWidth: 1,
    borderRightColor: 'transparent',
  },
  headerCell: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderBottomWidth: 1,
    paddingHorizontal: 12,
  },
  teamLabel: {
    fontSize: 13,
    fontWeight: '500',
  },
  memberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    gap: 10,
  },
  memberAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarText: {
    fontSize: 13,
    fontWeight: '600',
  },
  memberInfo: {
    flex: 1,
  },
  memberNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  memberName: {
    fontSize: 14,
    fontWeight: '500',
    flex: 1,
  },
  statusBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  statusBadgeText: {
    fontSize: 11,
    fontWeight: '600',
  },
  memberRole: {
    fontSize: 11,
    marginTop: 2,
  },
  dateHeaders: {
    flexDirection: 'row',
    borderBottomWidth: 1,
  },
  dateHeader: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  todayHeader: {},
  dayLabel: {
    fontSize: 11,
    fontWeight: '500',
  },
  dayNumber: {
    width: 28,
    height: 28,
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center',
  },
  todayNumber: {
    backgroundColor: '#3B82F6',
  },
  dayNumberText: {
    fontSize: 14,
    fontWeight: '600',
  },
  taskRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    position: 'relative',
  },
  dayCell: {
    borderRightWidth: 1,
    justifyContent: 'flex-end',
    alignItems: 'center',
    paddingBottom: 4,
  },
  capacityDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  taskBarsContainer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  taskBar: {
    position: 'absolute',
    height: 18,
    borderRadius: 4,
    borderLeftWidth: 3,
    paddingHorizontal: 6,
    justifyContent: 'center',
  },
  taskBarText: {
    fontSize: 11,
    fontWeight: '500',
  },
  legend: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 20,
    paddingVertical: 12,
    borderTopWidth: 1,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  legendDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  legendText: {
    fontSize: 12,
  },
});
