import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  StyleSheet,
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  TextInput,
  Modal,
  KeyboardAvoidingView,
  Platform,
  Dimensions,
} from 'react-native';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');
// Calculate column widths to fill screen
const TASK_COLUMN_WIDTH = 150;
const TOTAL_COLUMN_WIDTH = 67;
const DAY_COLUMN_WIDTH = Math.floor((SCREEN_WIDTH - TASK_COLUMN_WIDTH - TOTAL_COLUMN_WIDTH) / 7);
// Month view column width (7 equal columns)
const MONTH_DAY_WIDTH = Math.floor(SCREEN_WIDTH / 7);

import { useLocalSearchParams } from 'expo-router';
import {
  Clock,
  Play,
  Plus,
  ChevronLeft,
  ChevronRight,
  X,
} from 'lucide-react-native';
import api, { TimeEntry, ProjectTask } from '@/services/api';

// Light mode colors
const colors = {
  background: '#FFFFFF',
  card: '#FFFFFF',
  text: '#18181B',
  muted: '#71717A',
  border: '#E4E4E7',
  subtle: '#F4F4F5',
  primary: '#3B82F6',
  weekend: '#FAFAFA',
  todayColumn: '#EFF6FF',
};

const formatTimerDisplay = (seconds: number): string => {
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
};

const getWeekDates = (date: Date): Date[] => {
  const start = new Date(date);
  // Start from Monday
  const day = start.getDay();
  const diff = start.getDate() - day + (day === 0 ? -6 : 1);
  start.setDate(diff);

  const dates: Date[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    dates.push(d);
  }
  return dates;
};

const getMonthCalendarDates = (date: Date): Date[][] => {
  const year = date.getFullYear();
  const month = date.getMonth();

  // First day of month
  const firstDay = new Date(year, month, 1);
  // Last day of month
  const lastDay = new Date(year, month + 1, 0);

  // Start from Monday of the week containing the first day
  const startDate = new Date(firstDay);
  const dayOfWeek = startDate.getDay();
  const diff = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  startDate.setDate(startDate.getDate() + diff);

  const weeks: Date[][] = [];
  let currentDate = new Date(startDate);

  // Generate 5-6 weeks to cover the entire month
  while (currentDate <= lastDay || weeks.length < 5) {
    const week: Date[] = [];
    for (let i = 0; i < 7; i++) {
      week.push(new Date(currentDate));
      currentDate.setDate(currentDate.getDate() + 1);
    }
    weeks.push(week);
    if (weeks.length >= 6) break;
  }

  return weeks;
};

const formatDateKey = (date: Date): string => {
  return date.toISOString().split('T')[0];
};

const isToday = (date: Date): boolean => {
  const today = new Date();
  return date.toDateString() === today.toDateString();
};

const isWeekend = (date: Date): boolean => {
  const day = date.getDay();
  return day === 0 || day === 6;
};

const isSameMonth = (date: Date, referenceDate: Date): boolean => {
  return date.getMonth() === referenceDate.getMonth() &&
         date.getFullYear() === referenceDate.getFullYear();
};

const getDayName = (date: Date): string => {
  return date.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase();
};

const formatHours = (minutes: number): string => {
  if (minutes === 0) return '';
  const hours = minutes / 60;
  return `${hours.toFixed(1)}h`;
};

const formatTotalHours = (minutes: number): string => {
  const hours = minutes / 60;
  return `${hours.toFixed(1)}h`;
};

const WEEKDAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

export default function ProjectTimesheetScreen() {
  const { projectId } = useLocalSearchParams();
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [tasks, setTasks] = useState<ProjectTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [currentDate, setCurrentDate] = useState<Date>(new Date());
  const [viewMode, setViewMode] = useState<'week' | 'month'>('week');
  const weekDates = getWeekDates(currentDate);
  const monthWeeks = getMonthCalendarDates(currentDate);

  // Timer state
  const [timerRunning, setTimerRunning] = useState(false);
  const [timerSeconds, setTimerSeconds] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Modal state
  const [showAddModal, setShowAddModal] = useState(false);
  const [newEntryTask, setNewEntryTask] = useState('');
  const [selectedDay, setSelectedDay] = useState<Date | null>(null);
  const [showDayDetail, setShowDayDetail] = useState(false);

  // Mock task entries for display
  const [timesheetRows, setTimesheetRows] = useState<Array<{
    id: string;
    taskName: string;
    hours: Record<string, number>;
  }>>([
    { id: '1', taskName: 'wedwedskssk', hours: {} },
    { id: '2', taskName: 'dwedwedwed', hours: {} },
  ]);

  const loadData = useCallback(async () => {
    if (!projectId) return;

    try {
      setLoading(true);
      const [entriesRes, tasksRes] = await Promise.all([
        api.getProjectTimeEntries(projectId as string),
        api.getProjectTasksList(projectId as string),
      ]);

      if (entriesRes.success && entriesRes.data) {
        setEntries(entriesRes.data);
      }

      if (tasksRes.success && tasksRes.data) {
        setTasks(tasksRes.data);

        // Deduplicate tasks by ID to prevent React key collision
        const seenIds = new Set<string>();
        const uniqueTasks = tasksRes.data.filter(task => {
          if (seenIds.has(task.id)) {
            return false;
          }
          seenIds.add(task.id);
          return true;
        });

        const rows = uniqueTasks.slice(0, 5).map(task => ({
          id: task.id,
          taskName: task.title,
          hours: {} as Record<string, number>,
        }));

        if (rows.length > 0) {
          setTimesheetRows(rows);
        }
      }
    } catch (error) {
      console.error('Error loading timesheet data:', error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [projectId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    if (timerRunning) {
      timerRef.current = setInterval(() => {
        setTimerSeconds(s => s + 1);
      }, 1000);
    } else if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, [timerRunning]);

  const navigate = (direction: 'prev' | 'next') => {
    const newDate = new Date(currentDate);
    if (viewMode === 'week') {
      newDate.setDate(newDate.getDate() + (direction === 'next' ? 7 : -7));
    } else {
      newDate.setMonth(newDate.getMonth() + (direction === 'next' ? 1 : -1));
    }
    setCurrentDate(newDate);
  };

  const toggleTimer = () => {
    setTimerRunning(!timerRunning);
    if (timerRunning) {
      setTimerSeconds(0);
    }
  };

  const addEntry = () => {
    if (newEntryTask.trim()) {
      setTimesheetRows(prev => [...prev, {
        id: Date.now().toString(),
        taskName: newEntryTask.trim(),
        hours: {},
      }]);
      setNewEntryTask('');
      setShowAddModal(false);
    }
  };

  // Calculate totals
  const getRowTotal = (row: typeof timesheetRows[0]): number => {
    return Object.values(row.hours).reduce((sum, h) => sum + h, 0);
  };

  const getDayTotal = (dateKey: string): number => {
    return timesheetRows.reduce((sum, row) => sum + (row.hours[dateKey] || 0), 0);
  };

  const getWeekTotal = (): number => {
    return weekDates.reduce((sum, date) => sum + getDayTotal(formatDateKey(date)), 0);
  };

  // Format header text
  const formatHeaderText = (): string => {
    if (viewMode === 'week') {
      const start = weekDates[0];
      const end = weekDates[6];
      const startMonth = start.toLocaleDateString('en-US', { month: 'short' });
      const endMonth = end.toLocaleDateString('en-US', { month: 'short' });

      if (startMonth === endMonth) {
        return `${startMonth} ${start.getDate()} - ${end.getDate()}, ${end.getFullYear()}`;
      }
      return `${startMonth} ${start.getDate()} - ${endMonth} ${end.getDate()}, ${end.getFullYear()}`;
    } else {
      return currentDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    }
  };

  // Get entries for a specific date
  const getEntriesForDate = (date: Date) => {
    const dateKey = formatDateKey(date);
    return timesheetRows.map(row => ({
      taskName: row.taskName,
      hours: row.hours[dateKey] || 0,
    })).filter(e => e.hours > 0 || isToday(date));
  };

  // Check if a day column is today's weekday
  const isTodayColumn = (dayIndex: number): boolean => {
    const today = new Date();
    const todayDayIndex = today.getDay() === 0 ? 6 : today.getDay() - 1; // Convert to Mon=0 format
    return dayIndex === todayDayIndex;
  };

  // Open day detail modal
  const openDayDetail = (date: Date) => {
    setSelectedDay(date);
    setShowDayDetail(true);
  };

  // Get total hours for a specific date
  const getDayTotalHours = (date: Date): number => {
    const dateKey = formatDateKey(date);
    return timesheetRows.reduce((sum, row) => sum + (row.hours[dateKey] || 0), 0);
  };

  // Format date for display
  const formatDateDisplay = (date: Date): string => {
    return date.toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric'
    });
  };

  if (loading && !refreshing) {
    return (
      <View style={styles.centerContainer}>
        <ActivityIndicator size="large" color={colors.text} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Toolbar */}
      <View style={styles.toolbar}>
        <View style={styles.toolbarLeft}>
          {/* View Mode Toggle */}
          <View style={styles.viewToggle}>
            <TouchableOpacity
              style={[
                styles.viewToggleButton,
                viewMode === 'week' && styles.viewToggleButtonActive,
              ]}
              onPress={() => setViewMode('week')}
            >
              <Text style={[
                styles.viewToggleText,
                viewMode === 'week' && styles.viewToggleTextActive,
              ]}>Week</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.viewToggleButton,
                viewMode === 'month' && styles.viewToggleButtonActive,
              ]}
              onPress={() => setViewMode('month')}
            >
              <Text style={[
                styles.viewToggleText,
                viewMode === 'month' && styles.viewToggleTextActive,
              ]}>Month</Text>
            </TouchableOpacity>
          </View>

          {/* Navigation */}
          <TouchableOpacity
            style={styles.navButton}
            onPress={() => navigate('prev')}
          >
            <ChevronLeft size={18} color={colors.muted} strokeWidth={2} />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.navButton}
            onPress={() => navigate('next')}
          >
            <ChevronRight size={18} color={colors.muted} strokeWidth={2} />
          </TouchableOpacity>

          <Text style={styles.headerText}>{formatHeaderText()}</Text>
        </View>

        <View style={styles.toolbarRight}>
          {/* Timer */}
          <View style={styles.timerDisplay}>
            <Clock size={16} color={colors.muted} strokeWidth={2} />
            <Text style={styles.timerText}>{formatTimerDisplay(timerSeconds)}</Text>
            <TouchableOpacity onPress={toggleTimer} style={styles.playButton}>
              <Play
                size={14}
                color={timerRunning ? colors.primary : '#10B981'}
                strokeWidth={2}
                fill={timerRunning ? colors.primary : '#10B981'}
              />
            </TouchableOpacity>
          </View>

          {/* Log Time Button */}
          <TouchableOpacity
            style={styles.logTimeButton}
            onPress={() => setShowAddModal(true)}
          >
            <Plus size={16} color="#FFFFFF" strokeWidth={2} />
            <Text style={styles.logTimeButtonText}>Log time</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Week View */}
      {viewMode === 'week' && (
        <View style={styles.tableWrapper}>
          {/* Header Row */}
          <View style={styles.headerRow}>
            <View style={[styles.headerCell, styles.taskColumn]}>
              <Text style={styles.columnHeaderText}>TASK</Text>
            </View>
            {weekDates.map((date, index) => {
              const isCurrentDay = isToday(date);
              const isWeekendDay = isWeekend(date);
              return (
                <View
                  key={index}
                  style={[
                    styles.headerCell,
                    styles.dayColumn,
                    isWeekendDay && styles.weekendColumn,
                  ]}
                >
                  <Text style={[
                    styles.headerDayText,
                    isCurrentDay && styles.headerDayTextToday,
                  ]}>
                    {getDayName(date)}
                  </Text>
                  <Text style={[
                    styles.headerDateText,
                    isCurrentDay && styles.headerDateTextToday,
                  ]}>
                    {date.getDate()}
                  </Text>
                </View>
              );
            })}
            <View style={[styles.headerCell, styles.totalColumn]}>
              <Text style={styles.columnHeaderText}>TOTAL</Text>
            </View>
          </View>

          {/* Data Rows */}
          <ScrollView
            showsVerticalScrollIndicator={false}
            bounces={false}
            overScrollMode="never"
          >
            {timesheetRows.map((row, rowIndex) => {
              const rowTotal = getRowTotal(row);
              return (
                <View key={`${row.id}-${rowIndex}`} style={styles.dataRow}>
                  <View style={[styles.dataCell, styles.taskColumn]}>
                    <Text style={styles.taskName} numberOfLines={1}>
                      {row.taskName}
                    </Text>
                  </View>
                  {weekDates.map((date, index) => {
                    const dateKey = formatDateKey(date);
                    const hours = row.hours[dateKey] || 0;
                    const isWeekendDay = isWeekend(date);
                    return (
                      <TouchableOpacity
                        key={index}
                        style={[
                          styles.dataCell,
                          styles.dayColumn,
                          isWeekendDay && styles.weekendColumn,
                        ]}
                      >
                        <Text style={styles.hoursText}>
                          {formatHours(hours)}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                  <View style={[styles.dataCell, styles.totalColumn]}>
                    <Text style={styles.totalText}>
                      {formatTotalHours(rowTotal)}
                    </Text>
                  </View>
                </View>
              );
            })}

            {/* Add Entry Row */}
            <TouchableOpacity
              style={styles.addEntryRow}
              onPress={() => setShowAddModal(true)}
            >
              <View style={[styles.dataCell, styles.taskColumn]}>
                <View style={styles.addEntryContent}>
                  <Plus size={14} color={colors.muted} strokeWidth={2} />
                  <Text style={styles.addEntryText}>Add entry</Text>
                </View>
              </View>
              {weekDates.map((date, index) => {
                const isWeekendDay = isWeekend(date);
                return (
                  <View
                    key={index}
                    style={[
                      styles.dataCell,
                      styles.dayColumn,
                      isWeekendDay && styles.weekendColumn,
                    ]}
                  />
                );
              })}
              <View style={[styles.dataCell, styles.totalColumn]} />
            </TouchableOpacity>

            <View style={{ height: 100 }} />
          </ScrollView>

          {/* Daily Total Row (Footer) */}
          <View style={styles.footerRow}>
            <View style={[styles.footerCell, styles.taskColumn]}>
              <Text style={styles.footerLabel}>Daily Total</Text>
            </View>
            {weekDates.map((date, index) => {
              const dateKey = formatDateKey(date);
              const dayTotal = getDayTotal(dateKey);
              const isWeekendDay = isWeekend(date);
              return (
                <View
                  key={index}
                  style={[
                    styles.footerCell,
                    styles.dayColumn,
                    isWeekendDay && styles.weekendColumn,
                  ]}
                >
                  <Text style={styles.footerDash}>
                    {dayTotal > 0 ? formatTotalHours(dayTotal) : '—'}
                  </Text>
                </View>
              );
            })}
            <View style={[styles.footerCell, styles.totalColumn]}>
              <Text style={styles.footerTotal}>
                {formatTotalHours(getWeekTotal())}
              </Text>
            </View>
          </View>
        </View>
      )}

      {/* Month View */}
      {viewMode === 'month' && (
        <View style={styles.monthWrapper}>
          {/* Month Header Row */}
          <View style={styles.monthHeaderRow}>
            {WEEKDAYS.map((day, index) => {
              const isWeekendDay = index >= 5;
              const isTodayCol = isTodayColumn(index);
              return (
                <View
                  key={day}
                  style={[
                    styles.monthHeaderCell,
                    isWeekendDay && styles.monthWeekendHeader,
                  ]}
                >
                  <Text style={[
                    styles.monthHeaderText,
                    isWeekendDay && styles.monthWeekendHeaderText,
                  ]}>
                    {day}
                  </Text>
                </View>
              );
            })}
          </View>

          {/* Month Grid */}
          <ScrollView
            showsVerticalScrollIndicator={false}
            bounces={false}
          >
            {monthWeeks.map((week, weekIndex) => (
              <View key={weekIndex} style={styles.monthWeekRow}>
                {week.map((date, dayIndex) => {
                  const isCurrentDay = isToday(date);
                  const isWeekendDay = dayIndex >= 5;
                  const isCurrentMonth = isSameMonth(date, currentDate);
                  const isTodayCol = isTodayColumn(dayIndex);
                  const dayEntries = getEntriesForDate(date);

                  return (
                    <TouchableOpacity
                      key={dayIndex}
                      style={[
                        styles.monthDayCell,
                        isWeekendDay && styles.monthWeekendCell,
                        isTodayCol && isCurrentMonth && styles.monthTodayColumn,
                      ]}
                      onPress={() => openDayDetail(date)}
                      activeOpacity={0.7}
                    >
                      <View style={[
                        styles.monthDayHeader,
                        dayIndex === 0 && styles.monthDayHeaderFirst,
                      ]}>
                        {isCurrentDay ? (
                          <View style={styles.todayCircle}>
                            <Text style={styles.todayCircleText}>
                              {date.getDate()}
                            </Text>
                          </View>
                        ) : (
                          <Text style={[
                            styles.monthDayNumber,
                            !isCurrentMonth && styles.monthDayNumberMuted,
                          ]}>
                            {date.getDate()}
                          </Text>
                        )}
                      </View>
                      {/* Time entries for this day */}
                      <View style={styles.monthDayEntries}>
                        {timesheetRows.slice(0, 2).map((row, idx) => {
                          const dateKey = formatDateKey(date);
                          const hours = row.hours[dateKey] || 0;
                          if (!isCurrentDay && hours === 0) return null;
                          return (
                            <View key={idx} style={styles.monthEntryItem}>
                              <Text style={styles.monthEntryText} numberOfLines={1}>
                                {formatTotalHours(hours)} {row.taskName}
                              </Text>
                            </View>
                          );
                        })}
                      </View>
                    </TouchableOpacity>
                  );
                })}
              </View>
            ))}
          </ScrollView>
        </View>
      )}

      {/* Add Entry Modal */}
      <Modal visible={showAddModal} transparent animationType="fade">
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.modalOverlay}
        >
          <TouchableOpacity
            style={StyleSheet.absoluteFill}
            activeOpacity={1}
            onPress={() => setShowAddModal(false)}
          />
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Add entry</Text>
              <TouchableOpacity onPress={() => setShowAddModal(false)}>
                <X size={20} color={colors.muted} />
              </TouchableOpacity>
            </View>
            <View style={styles.modalBody}>
              <Text style={styles.formLabel}>Task name</Text>
              <TextInput
                style={styles.formInput}
                placeholder="Enter task name"
                placeholderTextColor="#A1A1AA"
                value={newEntryTask}
                onChangeText={setNewEntryTask}
                autoFocus
              />
            </View>
            <View style={styles.modalFooter}>
              <TouchableOpacity
                style={styles.cancelButton}
                onPress={() => setShowAddModal(false)}
              >
                <Text style={styles.cancelButtonText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.createButton,
                  !newEntryTask.trim() && styles.createButtonDisabled,
                ]}
                onPress={addEntry}
                disabled={!newEntryTask.trim()}
              >
                <Text style={styles.createButtonText}>Add entry</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Day Detail Modal */}
      <Modal visible={showDayDetail} transparent animationType="fade">
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPress={() => setShowDayDetail(false)}
        >
          <TouchableOpacity style={styles.dayDetailContent} activeOpacity={1}>
            <View style={styles.dayDetailHeader}>
              <View>
                <Text style={styles.dayDetailTitle}>
                  {selectedDay && formatDateDisplay(selectedDay)}
                </Text>
                <Text style={styles.dayDetailSubtitle}>
                  Total: {selectedDay ? formatTotalHours(getDayTotalHours(selectedDay)) : '0.0h'}
                </Text>
              </View>
              <TouchableOpacity onPress={() => setShowDayDetail(false)}>
                <X size={24} color={colors.muted} />
              </TouchableOpacity>
            </View>

            <ScrollView style={styles.dayDetailEntries}>
              {selectedDay && timesheetRows.map((row, rowIndex) => {
                const dateKey = formatDateKey(selectedDay);
                const hours = row.hours[dateKey] || 0;
                return (
                  <View key={`${row.id}-${rowIndex}`} style={styles.dayDetailEntry}>
                    <View style={styles.dayDetailEntryInfo}>
                      <Text style={styles.dayDetailEntryTask}>{row.taskName}</Text>
                      <Text style={styles.dayDetailEntryHours}>
                        {formatTotalHours(hours)}
                      </Text>
                    </View>
                    <TouchableOpacity style={styles.dayDetailEntryEdit}>
                      <Text style={styles.dayDetailEntryEditText}>Edit</Text>
                    </TouchableOpacity>
                  </View>
                );
              })}

              {timesheetRows.length === 0 && (
                <View style={styles.dayDetailEmpty}>
                  <Text style={styles.dayDetailEmptyText}>No entries for this day</Text>
                </View>
              )}
            </ScrollView>

            <TouchableOpacity
              style={styles.dayDetailAddButton}
              onPress={() => {
                setShowDayDetail(false);
                setShowAddModal(true);
              }}
            >
              <Plus size={18} color="#FFFFFF" strokeWidth={2} />
              <Text style={styles.dayDetailAddButtonText}>Add time entry</Text>
            </TouchableOpacity>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  centerContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: colors.background,
  },
  // Toolbar
  toolbar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  toolbarLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  toolbarRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  // View Toggle
  viewToggle: {
    flexDirection: 'row',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  viewToggleButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  viewToggleButtonActive: {
    backgroundColor: colors.text,
  },
  viewToggleText: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.text,
  },
  viewToggleTextActive: {
    color: '#FFFFFF',
  },
  // Navigation
  navButton: {
    padding: 4,
  },
  headerText: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.text,
    marginLeft: 4,
  },
  // Timer
  timerDisplay: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  timerText: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.muted,
    fontVariant: ['tabular-nums'],
  },
  playButton: {
    padding: 4,
  },
  // Log Time Button
  logTimeButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: colors.text,
  },
  logTimeButtonText: {
    fontSize: 13,
    color: '#FFFFFF',
    fontWeight: '500',
  },
  // Week View Table
  tableWrapper: {
    flex: 1,
  },
  headerRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerCell: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    justifyContent: 'center',
    borderRightWidth: 1,
    borderRightColor: colors.border,
  },
  columnHeaderText: {
    fontSize: 11,
    fontWeight: '500',
    color: colors.muted,
    letterSpacing: 0.5,
  },
  headerDayText: {
    fontSize: 11,
    fontWeight: '500',
    color: colors.muted,
    letterSpacing: 0.5,
  },
  headerDayTextToday: {
    color: colors.primary,
  },
  headerDateText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.text,
    marginTop: 2,
  },
  headerDateTextToday: {
    color: colors.primary,
  },
  // Column widths
  taskColumn: {
    width: TASK_COLUMN_WIDTH,
    paddingLeft: 16,
  },
  dayColumn: {
    width: DAY_COLUMN_WIDTH,
    alignItems: 'center',
  },
  totalColumn: {
    width: TOTAL_COLUMN_WIDTH,
    alignItems: 'flex-end',
    borderRightWidth: 0,
  },
  weekendColumn: {
    backgroundColor: colors.weekend,
  },
  // Data rows
  dataRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  dataCell: {
    paddingHorizontal: 12,
    paddingVertical: 12,
    justifyContent: 'center',
    borderRightWidth: 1,
    borderRightColor: colors.border,
    minHeight: 44,
  },
  taskName: {
    fontSize: 14,
    color: colors.text,
  },
  hoursText: {
    fontSize: 14,
    color: colors.text,
  },
  totalText: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.text,
  },
  // Add entry row
  addEntryRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  addEntryContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  addEntryText: {
    fontSize: 14,
    color: colors.muted,
  },
  // Footer row
  footerRow: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: colors.border,
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: colors.background,
  },
  footerCell: {
    paddingHorizontal: 12,
    paddingVertical: 12,
    justifyContent: 'center',
    borderRightWidth: 1,
    borderRightColor: colors.border,
  },
  footerLabel: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.text,
  },
  footerDash: {
    fontSize: 14,
    color: colors.muted,
  },
  footerTotal: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.text,
  },
  // Month View
  monthWrapper: {
    flex: 1,
  },
  monthHeaderRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  monthHeaderCell: {
    width: MONTH_DAY_WIDTH,
    paddingVertical: 10,
    alignItems: 'center',
    borderRightWidth: 1,
    borderRightColor: colors.border,
  },
  monthWeekendHeader: {
    backgroundColor: colors.weekend,
  },
  monthHeaderText: {
    fontSize: 11,
    fontWeight: '500',
    color: colors.muted,
    letterSpacing: 0.5,
  },
  monthWeekendHeaderText: {
    color: colors.muted,
  },
  monthWeekRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    minHeight: 120,
  },
  monthDayCell: {
    width: MONTH_DAY_WIDTH,
    padding: 8,
    borderRightWidth: 1,
    borderRightColor: colors.border,
  },
  monthWeekendCell: {
    backgroundColor: colors.weekend,
  },
  monthTodayColumn: {
    backgroundColor: colors.todayColumn,
  },
  monthDayHeader: {
    marginBottom: 4,
  },
  monthDayHeaderFirst: {
    marginLeft: 8,
  },
  monthDayNumber: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.text,
  },
  monthDayNumberMuted: {
    color: colors.muted,
  },
  todayCircle: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: colors.primary,
    justifyContent: 'center',
    alignItems: 'center',
  },
  todayCircleText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  monthDayEntries: {
    gap: 2,
  },
  monthEntryItem: {
    backgroundColor: '#F3F4F6',
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 4,
  },
  monthEntryText: {
    fontSize: 11,
    color: colors.muted,
  },
  // Modal
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  modalContent: {
    width: '100%',
    maxWidth: 400,
    backgroundColor: colors.card,
    borderRadius: 12,
    overflow: 'hidden',
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 20,
    paddingBottom: 0,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.text,
  },
  modalBody: {
    padding: 20,
  },
  modalFooter: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
    padding: 20,
    paddingTop: 0,
  },
  formLabel: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.text,
    marginBottom: 8,
  },
  formInput: {
    height: 40,
    backgroundColor: colors.card,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 12,
    fontSize: 14,
    color: colors.text,
  },
  cancelButton: {
    height: 40,
    paddingHorizontal: 16,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    justifyContent: 'center',
    alignItems: 'center',
  },
  cancelButtonText: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.text,
  },
  createButton: {
    height: 40,
    paddingHorizontal: 16,
    borderRadius: 10,
    backgroundColor: colors.text,
    justifyContent: 'center',
    alignItems: 'center',
  },
  createButtonDisabled: {
    opacity: 0.5,
  },
  createButtonText: {
    fontSize: 14,
    fontWeight: '500',
    color: '#FFFFFF',
  },
  // Day Detail Modal
  dayDetailContent: {
    width: '100%',
    maxWidth: 450,
    maxHeight: '80%',
    backgroundColor: colors.card,
    borderRadius: 12,
    overflow: 'hidden',
  },
  dayDetailHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    padding: 20,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  dayDetailTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.text,
    marginBottom: 4,
  },
  dayDetailSubtitle: {
    fontSize: 14,
    color: colors.muted,
  },
  dayDetailEntries: {
    maxHeight: 300,
  },
  dayDetailEntry: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  dayDetailEntryInfo: {
    flex: 1,
  },
  dayDetailEntryTask: {
    fontSize: 15,
    fontWeight: '500',
    color: colors.text,
    marginBottom: 2,
  },
  dayDetailEntryHours: {
    fontSize: 14,
    color: colors.muted,
  },
  dayDetailEntryEdit: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.border,
  },
  dayDetailEntryEditText: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.text,
  },
  dayDetailEmpty: {
    padding: 40,
    alignItems: 'center',
  },
  dayDetailEmptyText: {
    fontSize: 14,
    color: colors.muted,
  },
  dayDetailAddButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    margin: 20,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: colors.text,
  },
  dayDetailAddButtonText: {
    fontSize: 15,
    fontWeight: '500',
    color: '#FFFFFF',
  },
});
