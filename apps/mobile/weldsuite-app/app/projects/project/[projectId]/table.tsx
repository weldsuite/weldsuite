import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  StyleSheet,
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  TextInput,
  Modal,
  KeyboardAvoidingView,
  Platform,
  Alert,
  Pressable,
  Animated,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useLocalSearchParams } from 'expo-router';
import {
  Plus,
  Check,
  X,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  User,
  Calendar,
  Tag,
  CheckSquare,
  Circle,
  ListChecks,
  Users,
  Type,
  Hash,
  Sigma,
  Fingerprint,
  Timer,
  Clock,
  GitMerge,
  FolderKanban,
  CalendarCheck,
  Pencil,
  CalendarPlus,
  UserPlus,
  Trash2,
  EyeOff,
  ArrowLeft,
  ArrowRight,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Filter,
  Settings2,
  Eye,
  Columns3,
} from 'lucide-react-native';
import api, { ProjectTask, ProjectMember } from '@/services/api';

type EditingCell = {
  taskId: string;
  field: string;
  columnId?: string;
} | null;

type CustomFieldData = {
  [taskId: string]: {
    [fieldId: string]: any;
  };
};

// Light mode colors
const colors = {
  background: '#FFFFFF',
  card: '#FFFFFF',
  text: '#18181B',
  muted: '#71717A',
  border: '#E4E4E7',
  subtle: '#F4F4F5',
  primary: '#3B82F6',
};

const statusConfig: Record<string, { label: string; color: string; bg: string }> = {
  backlog: { label: 'backlog', color: '#71717A', bg: '#F4F4F5' },
  todo: { label: 'todo', color: '#F97316', bg: '#FFF7ED' },
  in_progress: { label: 'in progress', color: '#3B82F6', bg: '#EFF6FF' },
  in_review: { label: 'review', color: '#8B5CF6', bg: '#F5F3FF' },
  done: { label: 'done', color: '#22C55E', bg: '#F0FDF4' },
};

const priorityConfig: Record<string, { label: string; color: string; bg: string }> = {
  low: { label: 'low', color: '#71717A', bg: '#F4F4F5' },
  medium: { label: 'medium', color: '#3B82F6', bg: '#EFF6FF' },
  high: { label: 'high', color: '#F97316', bg: '#FFF7ED' },
  critical: { label: 'critical', color: '#EF4444', bg: '#FEF2F2' },
};

const formatDate = (dateString?: string): string => {
  if (!dateString) return '';
  const date = new Date(dateString);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

export default function ProjectTableScreen() {
  const { projectId } = useLocalSearchParams();
  const [tasks, setTasks] = useState<ProjectTask[]>([]);
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedTasks, setSelectedTasks] = useState<Set<string>>(new Set());

  // Modal states
  const [showAddModal, setShowAddModal] = useState(false);
  const [newTaskTitle, setNewTaskTitle] = useState('');

  // Editing states
  const [editingCell, setEditingCell] = useState<EditingCell>(null);
  const [editValue, setEditValue] = useState('');
  const [showPicker, setShowPicker] = useState(false);
  const [showTaskPicker, setShowTaskPicker] = useState(false);
  const [allProjectTasks, setAllProjectTasks] = useState<ProjectTask[]>([]);
  const [taskPickerRowId, setTaskPickerRowId] = useState<string | null>(null);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showDatePickerModal, setShowDatePickerModal] = useState(false);
  const [selectedDate, setSelectedDate] = useState(new Date());
  const datePickerFadeAnim = useRef(new Animated.Value(0)).current;

  // Custom field data storage
  const [customFields, setCustomFields] = useState<CustomFieldData>({});

  // Field-specific popup states
  const [showTextInput, setShowTextInput] = useState(false);
  const [showNumberInput, setShowNumberInput] = useState(false);
  const [showSelectPicker, setShowSelectPicker] = useState(false);
  const [showMultiSelectPicker, setShowMultiSelectPicker] = useState(false);
  const [showTagsPicker, setShowTagsPicker] = useState(false);
  const [textInputValue, setTextInputValue] = useState('');
  const [numberInputValue, setNumberInputValue] = useState('');
  const [newTagValue, setNewTagValue] = useState('');

  // Sample options for select fields
  const selectOptions = [
    { id: 'option1', label: 'Option 1', color: '#3B82F6' },
    { id: 'option2', label: 'Option 2', color: '#22C55E' },
    { id: 'option3', label: 'Option 3', color: '#F59E0B' },
    { id: 'option4', label: 'Option 4', color: '#EF4444' },
  ];

  // Column management
  const [showColumnPicker, setShowColumnPicker] = useState(false);
  const [visibleColumns, setVisibleColumns] = useState<string[]>([
    'status', 'priority', 'assignee', 'dueDate', 'tags'
  ]);
  const [showColumnOptionsModal, setShowColumnOptionsModal] = useState(false);
  const [selectedColumnForOptions, setSelectedColumnForOptions] = useState<string | null>(null);

  // Sort, Filter, View Settings
  const [showSortModal, setShowSortModal] = useState(false);
  const [showFilterModal, setShowFilterModal] = useState(false);
  const [showViewSettingsModal, setShowViewSettingsModal] = useState(false);

  // Sort configuration
  const [sortField, setSortField] = useState<string | null>(null);
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');

  // Filter configuration
  const [filters, setFilters] = useState<{ field: string; value: string }[]>([]);
  const [filterField, setFilterField] = useState<string>('status');
  const [filterValue, setFilterValue] = useState<string>('');

  // View settings
  const [showCompletedTasks, setShowCompletedTasks] = useState(true);
  const [compactView, setCompactView] = useState(false);

  // Sortable fields configuration
  const sortableFields = [
    { id: 'title', label: 'Task name' },
    { id: 'status', label: 'Status' },
    { id: 'priority', label: 'Priority' },
    { id: 'dueDate', label: 'Due date' },
    { id: 'createdAt', label: 'Created date' },
  ];

  // Filterable fields configuration
  const filterableFields = [
    { id: 'status', label: 'Status', options: Object.keys(statusConfig) },
    { id: 'priority', label: 'Priority', options: Object.keys(priorityConfig) },
  ];

  // Process tasks with sorting and filtering
  const processedTasks = useMemo(() => {
    let result = [...tasks];

    // Apply visibility filter (hide completed)
    if (!showCompletedTasks) {
      result = result.filter(task => task.status !== 'done');
    }

    // Apply filters
    filters.forEach(filter => {
      if (filter.field === 'status') {
        result = result.filter(task => task.status === filter.value);
      } else if (filter.field === 'priority') {
        result = result.filter(task => task.priority === filter.value);
      }
    });

    // Apply sorting
    if (sortField) {
      result.sort((a, b) => {
        let aVal: any;
        let bVal: any;

        switch (sortField) {
          case 'title':
            aVal = a.title?.toLowerCase() || '';
            bVal = b.title?.toLowerCase() || '';
            break;
          case 'status':
            const statusOrder = ['backlog', 'todo', 'in_progress', 'in_review', 'done'];
            aVal = statusOrder.indexOf(a.status);
            bVal = statusOrder.indexOf(b.status);
            break;
          case 'priority':
            const priorityOrder = ['low', 'medium', 'high', 'critical'];
            aVal = priorityOrder.indexOf(a.priority);
            bVal = priorityOrder.indexOf(b.priority);
            break;
          case 'dueDate':
            aVal = a.dueDate ? new Date(a.dueDate).getTime() : Infinity;
            bVal = b.dueDate ? new Date(b.dueDate).getTime() : Infinity;
            break;
          case 'createdAt':
            aVal = a.createdAt ? new Date(a.createdAt).getTime() : 0;
            bVal = b.createdAt ? new Date(b.createdAt).getTime() : 0;
            break;
          default:
            return 0;
        }

        if (aVal < bVal) return sortDirection === 'asc' ? -1 : 1;
        if (aVal > bVal) return sortDirection === 'asc' ? 1 : -1;
        return 0;
      });
    }

    return result;
  }, [tasks, sortField, sortDirection, filters, showCompletedTasks]);

  // Apply sort
  const applySort = (field: string) => {
    if (sortField === field) {
      // Toggle direction or clear
      if (sortDirection === 'asc') {
        setSortDirection('desc');
      } else {
        setSortField(null);
        setSortDirection('asc');
      }
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
    setShowSortModal(false);
  };

  // Clear sort
  const clearSort = () => {
    setSortField(null);
    setSortDirection('asc');
    setShowSortModal(false);
  };

  // Add filter
  const addFilter = () => {
    if (filterValue) {
      setFilters(prev => [...prev, { field: filterField, value: filterValue }]);
      setFilterValue('');
    }
    setShowFilterModal(false);
  };

  // Remove filter
  const removeFilter = (index: number) => {
    setFilters(prev => prev.filter((_, i) => i !== index));
  };

  // Clear all filters
  const clearFilters = () => {
    setFilters([]);
    setShowFilterModal(false);
  };

  // Track measured column widths - auto-sizes based on largest content
  const [columnWidths, setColumnWidths] = useState<{ [key: string]: number }>({});
  const pendingWidths = useRef<{ [key: string]: number }>({});
  const measurementTimer = useRef<NodeJS.Timeout | null>(null);

  // Minimum column widths
  const getMinColumnWidth = (colId: string) => {
    switch (colId) {
      case 'task': return 180;
      case 'status': return 120;
      case 'priority': return 100;
      case 'assignee': return 140;
      case 'people': return 140;
      case 'dueDate': return 140;
      case 'date': return 140;
      case 'tags': return 120;
      case 'checkbox': return 110;
      case 'text': return 140;
      case 'number': return 90;
      case 'id': return 110;
      case 'singleSelect': return 140;
      case 'multiSelect': return 140;
      case 'createdOn': return 150;
      case 'lastModifiedOn': return 160;
      case 'completedOn': return 150;
      case 'createdBy': return 130;
      case 'timer': return 90;
      case 'timeTracking': return 120;
      case 'collaborators': return 140;
      case 'projects': return 140;
      case 'formula': return 120;
      case 'rollup': return 120;
      default: return 120;
    }
  };

  // Get column width - uses measured width if larger than minimum
  const getColumnWidth = (colId: string) => {
    const minWidth = getMinColumnWidth(colId);
    const measured = columnWidths[colId] || 0;
    return Math.max(minWidth, measured);
  };

  // Collect measurements and batch update after all cells render
  const updateColumnWidth = useCallback((colId: string, contentWidth: number) => {
    const padding = 28;
    const newWidth = contentWidth + padding;
    const currentMax = pendingWidths.current[colId] || 0;

    if (newWidth > currentMax) {
      pendingWidths.current[colId] = newWidth;
    }

    // Debounce the state update to batch all measurements
    if (measurementTimer.current) {
      clearTimeout(measurementTimer.current);
    }
    measurementTimer.current = setTimeout(() => {
      setColumnWidths(prev => {
        const newWidths = { ...prev };
        let hasChanges = false;

        for (const [key, value] of Object.entries(pendingWidths.current)) {
          if (value !== prev[key]) {
            newWidths[key] = value;
            hasChanges = true;
          }
        }

        return hasChanges ? newWidths : prev;
      });
    }, 100);
  }, []);

  // Reset pending measurements when tasks change
  useEffect(() => {
    pendingWidths.current = {};
  }, [tasks]);

  // Storage key for column widths
  const storageKey = useMemo(() => `table_column_widths_${projectId}`, [projectId]);

  // Load saved column widths on mount
  useEffect(() => {
    const loadSavedWidths = async () => {
      try {
        const saved = await AsyncStorage.getItem(storageKey);
        if (saved) {
          const parsed = JSON.parse(saved);
          setColumnWidths(parsed);
          pendingWidths.current = parsed;
        }
      } catch (error) {
        console.error('Failed to load column widths:', error);
      }
    };
    loadSavedWidths();
  }, [storageKey]);

  // Save column widths when they change (debounced)
  const saveTimer = useRef<NodeJS.Timeout | null>(null);
  useEffect(() => {
    if (Object.keys(columnWidths).length === 0) return;

    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
    }
    saveTimer.current = setTimeout(async () => {
      try {
        await AsyncStorage.setItem(storageKey, JSON.stringify(columnWidths));
      } catch (error) {
        console.error('Failed to save column widths:', error);
      }
    }, 1000);

    return () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
      }
    };
  }, [columnWidths, storageKey]);

  const availableColumns = [
    // Currently used columns
    { id: 'task', label: 'Task', icon: CheckSquare },
    { id: 'status', label: 'Status', icon: Circle },
    { id: 'priority', label: 'Priority', icon: ListChecks },
    { id: 'assignee', label: 'Assignee', icon: User },
    { id: 'dueDate', label: 'Due Date', icon: CalendarCheck },
    { id: 'tags', label: 'Tags', icon: Tag },
    // Field types
    { id: 'checkbox', label: 'Checkbox', icon: CheckSquare },
    { id: 'singleSelect', label: 'Single-select', icon: Circle },
    { id: 'multiSelect', label: 'Multi-select', icon: ListChecks },
    { id: 'date', label: 'Date', icon: Calendar },
    { id: 'people', label: 'People', icon: User },
    { id: 'text', label: 'Text', icon: Type },
    { id: 'number', label: 'Number', icon: Hash },
    { id: 'formula', label: 'Formula', icon: Sigma },
    { id: 'id', label: 'ID', icon: Fingerprint },
    { id: 'timer', label: 'Timer', icon: Timer },
    { id: 'timeTracking', label: 'Time tracking', icon: Clock },
    { id: 'rollup', label: 'Rollup', icon: GitMerge },
    { id: 'projects', label: 'Projects', icon: FolderKanban },
    // Metadata columns
    { id: 'completedOn', label: 'Completed on', icon: CalendarCheck },
    { id: 'lastModifiedOn', label: 'Last modified on', icon: Pencil },
    { id: 'createdOn', label: 'Created on', icon: CalendarPlus },
    { id: 'createdBy', label: 'Created by', icon: UserPlus },
    { id: 'collaborators', label: 'Collaborators', icon: Users },
  ];

  const toggleColumn = (columnId: string) => {
    if (visibleColumns.includes(columnId)) {
      setVisibleColumns(prev => prev.filter(c => c !== columnId));
    } else {
      setVisibleColumns(prev => [...prev, columnId]);
    }
  };

  // Open column options modal
  const openColumnOptions = (columnId: string) => {
    setSelectedColumnForOptions(columnId);
    setShowColumnOptionsModal(true);
  };

  // Hide/remove a column
  const hideColumn = () => {
    if (selectedColumnForOptions) {
      setVisibleColumns(prev => prev.filter(c => c !== selectedColumnForOptions));
      setShowColumnOptionsModal(false);
      setSelectedColumnForOptions(null);
    }
  };

  // Move column left
  const moveColumnLeft = () => {
    if (!selectedColumnForOptions) return;
    const currentIndex = visibleColumns.indexOf(selectedColumnForOptions);
    if (currentIndex <= 0) return; // Already at the start

    const newColumns = [...visibleColumns];
    // Swap with the previous column
    [newColumns[currentIndex - 1], newColumns[currentIndex]] = [newColumns[currentIndex], newColumns[currentIndex - 1]];
    setVisibleColumns(newColumns);
    setShowColumnOptionsModal(false);
    setSelectedColumnForOptions(null);
  };

  // Move column right
  const moveColumnRight = () => {
    if (!selectedColumnForOptions) return;
    const currentIndex = visibleColumns.indexOf(selectedColumnForOptions);
    if (currentIndex >= visibleColumns.length - 1) return; // Already at the end

    const newColumns = [...visibleColumns];
    // Swap with the next column
    [newColumns[currentIndex], newColumns[currentIndex + 1]] = [newColumns[currentIndex + 1], newColumns[currentIndex]];
    setVisibleColumns(newColumns);
    setShowColumnOptionsModal(false);
    setSelectedColumnForOptions(null);
  };

  const loadData = useCallback(async () => {
    if (!projectId) return;

    try {
      setLoading(true);
      const [tasksRes, membersRes] = await Promise.all([
        api.getProjectTasksList(projectId as string),
        api.getProjectMembers(projectId as string),
      ]);

      if (tasksRes.success && tasksRes.data) {
        // Handle paginated response structure
        const taskItems = Array.isArray(tasksRes.data) ? tasksRes.data : tasksRes.data.items || [];
        setTasks(taskItems);
      }

      if (membersRes.success && membersRes.data) {
        // Handle paginated response structure
        const memberItems = Array.isArray(membersRes.data) ? membersRes.data : membersRes.data.items || membersRes.data;
        setMembers(memberItems);
      }
    } catch (error) {
      console.error('Error loading table data:', error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [projectId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Date picker animation
  useEffect(() => {
    if (showDatePicker) {
      setShowDatePickerModal(true);
      Animated.timing(datePickerFadeAnim, {
        toValue: 1,
        duration: 150,
        useNativeDriver: true,
      }).start();
    } else {
      Animated.timing(datePickerFadeAnim, {
        toValue: 0,
        duration: 150,
        useNativeDriver: true,
      }).start(() => setShowDatePickerModal(false));
    }
  }, [showDatePicker]);

  const handleRefresh = () => {
    setRefreshing(true);
    loadData();
  };

  const handleAddTask = async () => {
    if (!newTaskTitle.trim()) return;

    try {
      const response = await api.createProjectTask(projectId as string, {
        title: newTaskTitle.trim(),
        status: 'todo',
        priority: 'medium',
      });

      if (response.success) {
        setNewTaskTitle('');
        setShowAddModal(false);
        loadData();
      }
    } catch (error) {
      console.error('Failed to create task:', error);
    }
  };

  const toggleTaskSelection = (taskId: string) => {
    const newSelected = new Set(selectedTasks);
    if (newSelected.has(taskId)) {
      newSelected.delete(taskId);
    } else {
      newSelected.add(taskId);
    }
    setSelectedTasks(newSelected);
  };

  // Open task picker to select an existing task
  const openTaskPicker = async (rowId: string) => {
    setTaskPickerRowId(rowId);
    // Load all project tasks if not already loaded
    if (allProjectTasks.length === 0) {
      try {
        const response = await api.getProjectTasksList(projectId as string);
        if (response.success && response.data) {
          // Handle paginated response structure
          const taskItems = Array.isArray(response.data) ? response.data : response.data.items || [];
          setAllProjectTasks(taskItems);
        }
      } catch (error) {
        console.error('Failed to load tasks:', error);
      }
    }
    setShowTaskPicker(true);
  };

  // Select a task from the picker
  const selectTask = (task: ProjectTask) => {
    // Replace the placeholder row with the actual task or update the current row
    // For now, just add it to the displayed tasks if not already there
    if (!tasks.find(t => t.id === task.id)) {
      setTasks(prev => [...prev, task]);
    }
    setShowTaskPicker(false);
    setTaskPickerRowId(null);
  };

  // Start editing a cell
  const startEditing = (taskId: string, field: EditingCell['field'], currentValue: string) => {
    setEditingCell({ taskId, field });
    setEditValue(currentValue || '');
    if (field === 'status' || field === 'priority' || field === 'assignee') {
      setShowPicker(true);
    } else if (field === 'dueDate') {
      // Set the date picker to the current value or today
      if (currentValue) {
        setSelectedDate(new Date(currentValue));
      } else {
        setSelectedDate(new Date());
      }
      setShowDatePicker(true);
    }
  };

  // Date helper functions
  const isToday = (date: Date) => {
    const today = new Date();
    return date.toDateString() === today.toDateString();
  };

  const isTomorrow = (date: Date) => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    return date.toDateString() === tomorrow.toDateString();
  };

  const getDateOption = (option: 'today' | 'tomorrow' | 'nextWeek' | 'clear') => {
    const date = new Date();
    switch (option) {
      case 'today':
        return date.toISOString();
      case 'tomorrow':
        date.setDate(date.getDate() + 1);
        return date.toISOString();
      case 'nextWeek':
        date.setDate(date.getDate() + 7);
        return date.toISOString();
      case 'clear':
        return null;
    }
  };

  const selectDateValue = async (taskId: string, dateValue: string | null) => {
    try {
      const response = await api.updateProjectTask(projectId as string, taskId, {
        dueDate: dateValue,
      });

      if (response.success) {
        loadData();
      }
    } catch (error) {
      console.error('Failed to update date:', error);
    } finally {
      setShowDatePicker(false);
      cancelEdit();
    }
  };

  const confirmDateSelection = () => {
    if (editingCell) {
      selectDateValue(editingCell.taskId, selectedDate.toISOString());
    }
  };

  const cancelDatePicker = () => {
    setShowDatePicker(false);
    cancelEdit();
  };

  const clearDate = () => {
    if (editingCell) {
      selectDateValue(editingCell.taskId, null);
    }
  };

  // Custom field helpers
  const getCustomFieldValue = (taskId: string, fieldId: string) => {
    return customFields[taskId]?.[fieldId];
  };

  const setCustomFieldValue = (taskId: string, fieldId: string, value: any) => {
    setCustomFields(prev => ({
      ...prev,
      [taskId]: {
        ...prev[taskId],
        [fieldId]: value,
      },
    }));
  };

  const openFieldEditor = (taskId: string, columnId: string) => {
    setEditingCell({ taskId, field: columnId, columnId });

    switch (columnId) {
      case 'text':
        setTextInputValue(getCustomFieldValue(taskId, columnId) || '');
        setShowTextInput(true);
        break;
      case 'number':
        setNumberInputValue(getCustomFieldValue(taskId, columnId)?.toString() || '');
        setShowNumberInput(true);
        break;
      case 'singleSelect':
        setShowSelectPicker(true);
        break;
      case 'multiSelect':
        setShowMultiSelectPicker(true);
        break;
      case 'tags':
        setShowTagsPicker(true);
        break;
      case 'checkbox':
        // Toggle immediately
        const currentValue = getCustomFieldValue(taskId, columnId) || false;
        setCustomFieldValue(taskId, columnId, !currentValue);
        break;
      case 'date':
        const currentDate = getCustomFieldValue(taskId, columnId);
        setSelectedDate(currentDate ? new Date(currentDate) : new Date());
        setShowDatePicker(true);
        break;
    }
  };

  const saveTextInput = () => {
    if (editingCell?.columnId) {
      setCustomFieldValue(editingCell.taskId, editingCell.columnId, textInputValue);
    }
    setShowTextInput(false);
    setEditingCell(null);
  };

  const saveNumberInput = () => {
    if (editingCell?.columnId) {
      const numValue = parseFloat(numberInputValue) || 0;
      setCustomFieldValue(editingCell.taskId, editingCell.columnId, numValue);
    }
    setShowNumberInput(false);
    setEditingCell(null);
  };

  const selectOption = (optionId: string) => {
    if (editingCell?.columnId) {
      setCustomFieldValue(editingCell.taskId, editingCell.columnId, optionId);
    }
    setShowSelectPicker(false);
    setEditingCell(null);
  };

  const toggleMultiSelectOption = (optionId: string) => {
    if (editingCell?.columnId) {
      const currentValues: string[] = getCustomFieldValue(editingCell.taskId, editingCell.columnId) || [];
      const newValues = currentValues.includes(optionId)
        ? currentValues.filter(id => id !== optionId)
        : [...currentValues, optionId];
      setCustomFieldValue(editingCell.taskId, editingCell.columnId, newValues);
    }
  };

  const addTag = () => {
    if (editingCell?.columnId && newTagValue.trim()) {
      const currentTags: string[] = getCustomFieldValue(editingCell.taskId, editingCell.columnId) || [];
      if (!currentTags.includes(newTagValue.trim())) {
        setCustomFieldValue(editingCell.taskId, editingCell.columnId, [...currentTags, newTagValue.trim()]);
      }
      setNewTagValue('');
    }
  };

  const removeTag = (tag: string) => {
    if (editingCell?.columnId) {
      const currentTags: string[] = getCustomFieldValue(editingCell.taskId, editingCell.columnId) || [];
      setCustomFieldValue(editingCell.taskId, editingCell.columnId, currentTags.filter(t => t !== tag));
    }
  };

  const saveCustomDate = () => {
    if (editingCell?.columnId) {
      setCustomFieldValue(editingCell.taskId, editingCell.columnId, selectedDate.toISOString());
    }
    setShowDatePicker(false);
    setEditingCell(null);
  };

  // Save cell edit
  const saveEdit = async () => {
    if (!editingCell) return;

    try {
      const updateData: any = {};

      if (editingCell.field === 'title') {
        updateData.title = editValue;
      } else if (editingCell.field === 'status') {
        updateData.status = editValue;
      } else if (editingCell.field === 'priority') {
        updateData.priority = editValue;
      } else if (editingCell.field === 'assignee') {
        updateData.assigneeId = editValue || null;
      } else if (editingCell.field === 'dueDate') {
        updateData.dueDate = editValue || null;
      }

      const response = await api.updateProjectTask(projectId as string, editingCell.taskId, updateData);

      if (response.success) {
        loadData();
      }
    } catch (error) {
      console.error('Failed to update:', error);
    } finally {
      cancelEdit();
    }
  };

  // Cancel editing
  const cancelEdit = () => {
    setEditingCell(null);
    setEditValue('');
    setShowPicker(false);
  };

  // Quick select for picker fields
  const selectPickerValue = async (taskId: string, field: string, value: string) => {
    try {
      const updateData: any = {};
      if (field === 'status') {
        updateData.status = value;
      } else if (field === 'priority') {
        updateData.priority = value;
      } else if (field === 'assignee') {
        updateData.assigneeId = value || null;
      }

      const response = await api.updateProjectTask(projectId as string, taskId, updateData);

      if (response.success) {
        loadData();
      }
    } catch (error) {
      console.error('Failed to update:', error);
    } finally {
      cancelEdit();
    }
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
          <TouchableOpacity
            style={[styles.toolbarButton, sortField && styles.toolbarButtonActive]}
            onPress={() => setShowSortModal(true)}
          >
            <Text style={[styles.toolbarButtonText, sortField && styles.toolbarButtonTextActive]}>
              {sortField ? `Sort: ${sortableFields.find(f => f.id === sortField)?.label}` : 'Sort'}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.toolbarButton, filters.length > 0 && styles.toolbarButtonActive]}
            onPress={() => setShowFilterModal(true)}
          >
            <Text style={[styles.toolbarButtonText, filters.length > 0 && styles.toolbarButtonTextActive]}>
              {filters.length > 0 ? `Filter (${filters.length})` : 'Filter'}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.toolbarButton}
            onPress={() => setShowViewSettingsModal(true)}
          >
            <Text style={styles.toolbarButtonText}>View</Text>
          </TouchableOpacity>
        </View>
        <View style={styles.toolbarRight}>
          <TouchableOpacity
            style={styles.newTaskButton}
            onPress={() => setShowAddModal(true)}
          >
            <Plus size={16} color="#FFFFFF" strokeWidth={2} />
            <Text style={styles.newTaskButtonText}>New task</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Table */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        bounces={false}
      >
        <View style={styles.tableWrapper}>
          {/* Header Row */}
          <View style={styles.headerRow}>
            <View style={[styles.headerCell, styles.checkboxCell]}>
              <Text style={styles.headerText}>Tasks</Text>
            </View>
            {visibleColumns.map((colId) => {
              const column = availableColumns.find(c => c.id === colId);
              if (!column) return null;
              const IconComponent = column.icon;
              const width = getColumnWidth(colId);
              return (
                <TouchableOpacity
                  key={colId}
                  style={[styles.headerCell, { width }]}
                  onPress={() => openColumnOptions(colId)}
                  activeOpacity={0.7}
                >
                  <IconComponent size={14} color={colors.muted} strokeWidth={1.5} />
                  <Text style={styles.headerText} numberOfLines={1} ellipsizeMode="tail">{column.label}</Text>
                </TouchableOpacity>
              );
            })}
            <TouchableOpacity
              style={[styles.headerCell, styles.addCell]}
              onPress={() => setShowColumnPicker(true)}
            >
              <Plus size={16} color={colors.muted} />
              <Text style={styles.headerText}>Add</Text>
            </TouchableOpacity>
          </View>

          {/* Data Rows */}
          <ScrollView
            showsVerticalScrollIndicator={false}
            bounces={false}
            overScrollMode="never"
          >
            {processedTasks.map((task, index) => {
              const status = statusConfig[task.status] || statusConfig.todo;
              const priority = priorityConfig[task.priority] || priorityConfig.medium;
              const assignee = members.find(m => m.userId === task.assigneeId);

              const renderCell = (colId: string) => {
                const width = getColumnWidth(colId);

                switch (colId) {
                  case 'task':
                    return (
                      <View key={colId} style={[styles.dataCell, { width }]}>
                        <TouchableOpacity
                          style={styles.cellTouchable}
                          onPress={() => startEditing(task.id, 'title', task.title)}
                        >
                          {editingCell?.taskId === task.id && editingCell?.field === 'title' ? (
                            <TextInput
                              style={styles.cellInput}
                              value={editValue}
                              onChangeText={setEditValue}
                              onBlur={saveEdit}
                              onSubmitEditing={saveEdit}
                              autoFocus
                            />
                          ) : (
                            <Text
                              style={styles.taskTitle}
                              numberOfLines={1}
                              ellipsizeMode="tail"
                              onLayout={(e) => updateColumnWidth(colId, e.nativeEvent.layout.width)}
                            >
                              {task.title}
                            </Text>
                          )}
                        </TouchableOpacity>
                      </View>
                    );
                  case 'status':
                    return (
                      <View key={colId} style={[styles.dataCell, { width }]}>
                        <TouchableOpacity
                          style={styles.cellTouchable}
                          onPress={() => startEditing(task.id, 'status', task.status)}
                        >
                          <View style={[styles.badge, { backgroundColor: status.bg }]}>
                            <Text style={[styles.badgeText, { color: status.color }]}>
                              {status.label}
                            </Text>
                          </View>
                        </TouchableOpacity>
                      </View>
                    );
                  case 'priority':
                    return (
                      <View key={colId} style={[styles.dataCell, { width }]}>
                        <TouchableOpacity
                          style={styles.cellTouchable}
                          onPress={() => startEditing(task.id, 'priority', task.priority)}
                        >
                          <View style={[styles.badge, { backgroundColor: priority.bg }]}>
                            <Text style={[styles.badgeText, { color: priority.color }]}>
                              {priority.label}
                            </Text>
                          </View>
                        </TouchableOpacity>
                      </View>
                    );
                  case 'assignee':
                  case 'people':
                    return (
                      <View key={colId} style={[styles.dataCell, { width }]}>
                        <TouchableOpacity
                          style={styles.cellTouchable}
                          onPress={() => startEditing(task.id, 'assignee', task.assigneeId || '')}
                        >
                          {assignee ? (
                            <View
                              style={styles.assigneeRow}
                              onLayout={(e) => updateColumnWidth(colId, e.nativeEvent.layout.width)}
                            >
                              <View style={styles.assigneeAvatar}>
                                <Text style={styles.avatarText}>
                                  {(assignee.user?.name || 'U').charAt(0).toUpperCase()}
                                </Text>
                              </View>
                              <Text style={styles.assigneeName} numberOfLines={1} ellipsizeMode="tail">
                                {assignee.user?.name || 'Unknown'}
                              </Text>
                            </View>
                          ) : (
                            <Text style={styles.placeholderText}>+ Add</Text>
                          )}
                        </TouchableOpacity>
                      </View>
                    );
                  case 'dueDate':
                  case 'date':
                    return (
                      <View key={colId} style={[styles.dataCell, { width }]}>
                        <TouchableOpacity
                          style={styles.cellTouchable}
                          onPress={() => startEditing(task.id, 'dueDate', task.dueDate || '')}
                        >
                          {task.dueDate ? (
                            <Text style={styles.dateText} numberOfLines={1} ellipsizeMode="tail">
                              {formatDate(task.dueDate)}
                            </Text>
                          ) : (
                            <Text style={styles.placeholderText}>+ Add</Text>
                          )}
                        </TouchableOpacity>
                      </View>
                    );
                  case 'tags': {
                    const tags: string[] = getCustomFieldValue(task.id, colId) || [];
                    return (
                      <View key={colId} style={[styles.dataCell, { width }]}>
                        <TouchableOpacity
                          style={styles.cellTouchable}
                          onPress={() => openFieldEditor(task.id, colId)}
                        >
                          {tags.length > 0 ? (
                            <View
                              style={styles.tagsRow}
                              onLayout={(e) => updateColumnWidth(colId, e.nativeEvent.layout.width)}
                            >
                              {tags.map((tag, i) => (
                                <View key={i} style={styles.tagBadge}>
                                  <Text style={styles.tagText}>{tag}</Text>
                                </View>
                              ))}
                            </View>
                          ) : (
                            <Text style={styles.placeholderText}>+ Add</Text>
                          )}
                        </TouchableOpacity>
                      </View>
                    );
                  }
                  case 'checkbox': {
                    const isChecked = getCustomFieldValue(task.id, colId) || false;
                    return (
                      <View key={colId} style={[styles.dataCell, { width }]}>
                        <TouchableOpacity
                          style={styles.cellTouchable}
                          onPress={() => openFieldEditor(task.id, colId)}
                        >
                          <View style={[styles.checkboxBox, isChecked && styles.checkboxChecked]}>
                            {isChecked && <Check size={14} color="#FFFFFF" strokeWidth={2.5} />}
                          </View>
                        </TouchableOpacity>
                      </View>
                    );
                  }
                  case 'singleSelect': {
                    const selectedId = getCustomFieldValue(task.id, colId);
                    const selectedOption = selectOptions.find(o => o.id === selectedId);
                    return (
                      <View key={colId} style={[styles.dataCell, { width }]}>
                        <TouchableOpacity
                          style={styles.cellTouchable}
                          onPress={() => openFieldEditor(task.id, colId)}
                        >
                          {selectedOption ? (
                            <View style={[styles.selectBadge, { backgroundColor: selectedOption.color + '20' }]}>
                              <Text style={[styles.selectBadgeText, { color: selectedOption.color }]}>
                                {selectedOption.label}
                              </Text>
                            </View>
                          ) : (
                            <Text style={styles.placeholderText}>+ Add</Text>
                          )}
                        </TouchableOpacity>
                      </View>
                    );
                  }
                  case 'multiSelect': {
                    const selectedIds: string[] = getCustomFieldValue(task.id, colId) || [];
                    const selectedOpts = selectOptions.filter(o => selectedIds.includes(o.id));
                    return (
                      <View key={colId} style={[styles.dataCell, { width }]}>
                        <TouchableOpacity
                          style={styles.cellTouchable}
                          onPress={() => openFieldEditor(task.id, colId)}
                        >
                          {selectedOpts.length > 0 ? (
                            <View
                              style={styles.tagsRow}
                              onLayout={(e) => updateColumnWidth(colId, e.nativeEvent.layout.width)}
                            >
                              {selectedOpts.map((opt) => (
                                <View key={opt.id} style={[styles.selectBadge, { backgroundColor: opt.color + '20' }]}>
                                  <Text style={[styles.selectBadgeText, { color: opt.color }]}>{opt.label}</Text>
                                </View>
                              ))}
                            </View>
                          ) : (
                            <Text style={styles.placeholderText}>+ Add</Text>
                          )}
                        </TouchableOpacity>
                      </View>
                    );
                  }
                  case 'text': {
                    const textValue = getCustomFieldValue(task.id, colId);
                    return (
                      <View key={colId} style={[styles.dataCell, { width }]}>
                        <TouchableOpacity
                          style={styles.cellTouchable}
                          onPress={() => openFieldEditor(task.id, colId)}
                        >
                          {textValue ? (
                            <Text
                              style={styles.cellText}
                              numberOfLines={1}
                              ellipsizeMode="tail"
                              onLayout={(e) => updateColumnWidth(colId, e.nativeEvent.layout.width)}
                            >
                              {textValue}
                            </Text>
                          ) : (
                            <Text style={styles.placeholderText}>+ Add</Text>
                          )}
                        </TouchableOpacity>
                      </View>
                    );
                  }
                  case 'number': {
                    const numValue = getCustomFieldValue(task.id, colId);
                    return (
                      <View key={colId} style={[styles.dataCell, { width }]}>
                        <TouchableOpacity
                          style={styles.cellTouchable}
                          onPress={() => openFieldEditor(task.id, colId)}
                        >
                          {numValue !== undefined ? (
                            <Text style={styles.cellText} numberOfLines={1} ellipsizeMode="tail">{numValue}</Text>
                          ) : (
                            <Text style={styles.placeholderText}>+ Add</Text>
                          )}
                        </TouchableOpacity>
                      </View>
                    );
                  }
                  case 'createdOn':
                    return (
                      <View key={colId} style={[styles.dataCell, { width }]}>
                        <Text style={styles.dateText} numberOfLines={1} ellipsizeMode="tail">
                          {task.createdAt ? formatDate(task.createdAt) : '-'}
                        </Text>
                      </View>
                    );
                  case 'lastModifiedOn':
                  case 'completedOn':
                    return (
                      <View key={colId} style={[styles.dataCell, { width }]}>
                        <Text style={styles.dateText} numberOfLines={1} ellipsizeMode="tail">-</Text>
                      </View>
                    );
                  case 'createdBy':
                    return (
                      <View key={colId} style={[styles.dataCell, { width }]}>
                        <Text style={styles.cellText} numberOfLines={1} ellipsizeMode="tail">System</Text>
                      </View>
                    );
                  case 'id':
                    return (
                      <View key={colId} style={[styles.dataCell, { width }]}>
                        <Text style={styles.cellText} numberOfLines={1} ellipsizeMode="tail">{task.id.slice(0, 8)}</Text>
                      </View>
                    );
                  case 'formula':
                  case 'rollup':
                    return (
                      <View key={colId} style={[styles.dataCell, { width }]}>
                        <Text style={styles.placeholderText}>-</Text>
                      </View>
                    );
                  case 'timer':
                  case 'timeTracking': {
                    const timeValue = getCustomFieldValue(task.id, colId) || 0;
                    return (
                      <View key={colId} style={[styles.dataCell, { width }]}>
                        <TouchableOpacity
                          style={styles.cellTouchable}
                          onPress={() => {
                            // Simple increment by 1 hour for demo
                            setCustomFieldValue(task.id, colId, timeValue + 1);
                          }}
                        >
                          {timeValue > 0 ? (
                            <Text style={styles.cellText} numberOfLines={1} ellipsizeMode="tail">{timeValue}h</Text>
                          ) : (
                            <Text style={styles.placeholderText}>0h</Text>
                          )}
                        </TouchableOpacity>
                      </View>
                    );
                  }
                  case 'collaborators':
                  case 'projects':
                    return (
                      <View key={colId} style={[styles.dataCell, { width }]}>
                        <TouchableOpacity style={styles.cellTouchable}>
                          <Text style={styles.placeholderText}>+ Add</Text>
                        </TouchableOpacity>
                      </View>
                    );
                  default:
                    return (
                      <View key={colId} style={[styles.dataCell, { width }]}>
                        <Text style={styles.placeholderText}>-</Text>
                      </View>
                    );
                }
              };

              return (
                <View key={`${task.id}-${index}`} style={styles.dataRow}>
                  {/* Task title - first column */}
                  <View style={[styles.dataCell, styles.checkboxCell]}>
                    <TouchableOpacity
                      style={styles.cellTouchable}
                      onPress={() => startEditing(task.id, 'title', task.title)}
                    >
                      {editingCell?.taskId === task.id && editingCell?.field === 'title' ? (
                        <TextInput
                          style={styles.cellInput}
                          value={editValue}
                          onChangeText={setEditValue}
                          onBlur={() => saveEdit(task.id, 'title')}
                          autoFocus
                        />
                      ) : (
                        <Text
                          style={styles.taskTitle}
                          numberOfLines={1}
                          ellipsizeMode="tail"
                        >
                          {task.title}
                        </Text>
                      )}
                    </TouchableOpacity>
                  </View>

                  {/* Dynamic columns */}
                  {visibleColumns.map(colId => renderCell(colId))}

                  {/* Add cell placeholder */}
                  <View style={[styles.dataCell, styles.addCell]} />
                </View>
              );
            })}

            {tasks.length === 0 && (
              <View style={styles.emptyState}>
                <Text style={styles.emptyText}>No tasks yet</Text>
              </View>
            )}

            {/* Add Row Button */}
            <TouchableOpacity
              style={styles.addRowButton}
              onPress={() => setShowAddModal(true)}
            >
              <Plus size={16} color={colors.muted} />
              <Text style={styles.addRowText}>Add row</Text>
            </TouchableOpacity>

            <View style={{ height: 100 }} />
          </ScrollView>
        </View>
      </ScrollView>

      {/* Column Picker Modal */}
      <Modal visible={showColumnPicker} transparent animationType="fade">
        <Pressable
          style={styles.pickerOverlay}
          onPress={() => setShowColumnPicker(false)}
        >
          <View style={styles.columnPickerContent}>
            <View style={styles.pickerHeader}>
              <Text style={styles.pickerTitle}>Add Column</Text>
              <TouchableOpacity onPress={() => setShowColumnPicker(false)}>
                <X size={20} color={colors.muted} />
              </TouchableOpacity>
            </View>
            <ScrollView style={styles.columnPickerScroll} showsVerticalScrollIndicator={false}>
              {availableColumns.map((column) => {
                const isVisible = visibleColumns.includes(column.id);
                const IconComponent = column.icon;
                return (
                  <TouchableOpacity
                    key={column.id}
                    style={[
                      styles.columnPickerItem,
                      isVisible && styles.columnPickerItemActive,
                    ]}
                    onPress={() => toggleColumn(column.id)}
                  >
                    <View style={styles.columnPickerIconContainer}>
                      <IconComponent size={18} color={colors.muted} strokeWidth={1.5} />
                    </View>
                    <Text style={[
                      styles.columnPickerLabel,
                      isVisible && styles.columnPickerLabelActive,
                    ]}>
                      {column.label}
                    </Text>
                    {isVisible && (
                      <Check size={16} color={colors.primary} strokeWidth={2} />
                    )}
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>
        </Pressable>
      </Modal>

      {/* Task Picker Modal */}
      <Modal visible={showTaskPicker} transparent animationType="fade">
        <Pressable
          style={styles.pickerOverlay}
          onPress={() => {
            setShowTaskPicker(false);
            setTaskPickerRowId(null);
          }}
        >
          <View style={styles.taskPickerContent}>
            <View style={styles.pickerHeader}>
              <Text style={styles.pickerTitle}>Select a task</Text>
              <TouchableOpacity onPress={() => {
                setShowTaskPicker(false);
                setTaskPickerRowId(null);
              }}>
                <X size={20} color={colors.muted} />
              </TouchableOpacity>
            </View>
            <ScrollView style={styles.taskPickerList}>
              {allProjectTasks.length === 0 ? (
                <View style={styles.emptyState}>
                  <Text style={styles.emptyText}>No tasks found</Text>
                </View>
              ) : (
                allProjectTasks.map((task, index) => {
                  const status = statusConfig[task.status] || statusConfig.todo;
                  const isAlreadyInTable = tasks.some(t => t.id === task.id);

                  return (
                    <TouchableOpacity
                      key={`${task.id}-${index}`}
                      style={[
                        styles.taskPickerItem,
                        isAlreadyInTable && styles.taskPickerItemDisabled,
                      ]}
                      onPress={() => !isAlreadyInTable && selectTask(task)}
                      disabled={isAlreadyInTable}
                    >
                      <View style={styles.taskPickerItemContent}>
                        <Text
                          style={[
                            styles.taskPickerItemTitle,
                            isAlreadyInTable && styles.taskPickerItemTitleDisabled,
                          ]}
                          numberOfLines={1}
                        >
                          {task.title}
                        </Text>
                        <View style={[styles.badge, { backgroundColor: status.bg }]}>
                          <Text style={[styles.badgeText, { color: status.color }]}>
                            {status.label}
                          </Text>
                        </View>
                      </View>
                      {isAlreadyInTable && (
                        <Text style={styles.alreadyAddedText}>Already in table</Text>
                      )}
                    </TouchableOpacity>
                  );
                })
              )}
            </ScrollView>
          </View>
        </Pressable>
      </Modal>

      {/* Picker Modal for Status/Priority/Assignee */}
      <Modal visible={showPicker && editingCell !== null} transparent animationType="fade">
        <Pressable style={styles.pickerOverlay} onPress={cancelEdit}>
          <View style={styles.pickerContent}>
            <View style={styles.pickerHeader}>
              <Text style={styles.pickerTitle}>
                {editingCell?.field === 'status' && 'Select Status'}
                {editingCell?.field === 'priority' && 'Select Priority'}
                {editingCell?.field === 'assignee' && 'Select Assignee'}
              </Text>
              <TouchableOpacity onPress={cancelEdit}>
                <X size={20} color={colors.muted} />
              </TouchableOpacity>
            </View>

            {/* Status Options */}
            {editingCell?.field === 'status' && (
              <View style={styles.pickerOptions}>
                {Object.entries(statusConfig).map(([key, config]) => (
                  <TouchableOpacity
                    key={key}
                    style={[
                      styles.pickerOption,
                      editingCell?.taskId && tasks.find(t => t.id === editingCell.taskId)?.status === key && styles.pickerOptionSelected,
                    ]}
                    onPress={() => selectPickerValue(editingCell!.taskId, 'status', key)}
                  >
                    <View style={[styles.badge, { backgroundColor: config.bg }]}>
                      <Text style={[styles.badgeText, { color: config.color }]}>
                        {config.label}
                      </Text>
                    </View>
                  </TouchableOpacity>
                ))}
              </View>
            )}

            {/* Priority Options */}
            {editingCell?.field === 'priority' && (
              <View style={styles.pickerOptions}>
                {Object.entries(priorityConfig).map(([key, config]) => (
                  <TouchableOpacity
                    key={key}
                    style={[
                      styles.pickerOption,
                      editingCell?.taskId && tasks.find(t => t.id === editingCell.taskId)?.priority === key && styles.pickerOptionSelected,
                    ]}
                    onPress={() => selectPickerValue(editingCell!.taskId, 'priority', key)}
                  >
                    <View style={[styles.badge, { backgroundColor: config.bg }]}>
                      <Text style={[styles.badgeText, { color: config.color }]}>
                        {config.label}
                      </Text>
                    </View>
                  </TouchableOpacity>
                ))}
              </View>
            )}

            {/* Assignee Options */}
            {editingCell?.field === 'assignee' && (
              <View style={styles.pickerOptions}>
                <TouchableOpacity
                  style={[
                    styles.pickerOption,
                    !tasks.find(t => t.id === editingCell?.taskId)?.assigneeId && styles.pickerOptionSelected,
                  ]}
                  onPress={() => selectPickerValue(editingCell!.taskId, 'assignee', '')}
                >
                  <Text style={styles.pickerOptionText}>Unassigned</Text>
                </TouchableOpacity>
                {members.map((member) => (
                  <TouchableOpacity
                    key={member.id}
                    style={[
                      styles.pickerOption,
                      tasks.find(t => t.id === editingCell?.taskId)?.assigneeId === member.userId && styles.pickerOptionSelected,
                    ]}
                    onPress={() => selectPickerValue(editingCell!.taskId, 'assignee', member.userId)}
                  >
                    <View style={styles.assigneeRow}>
                      <View style={styles.assigneeAvatar}>
                        <Text style={styles.avatarText}>
                          {(member.user?.name || 'U').charAt(0).toUpperCase()}
                        </Text>
                      </View>
                      <Text style={styles.pickerOptionText}>
                        {member.user?.name || 'Unknown'}
                      </Text>
                    </View>
                  </TouchableOpacity>
                ))}
              </View>
            )}

          </View>
        </Pressable>
      </Modal>

      {/* Date Picker Modal */}
      <Modal visible={showDatePickerModal} transparent animationType="none">
        <Animated.View style={[styles.pickerOverlay, { opacity: datePickerFadeAnim }]}>
          <TouchableOpacity
            style={StyleSheet.absoluteFill}
            activeOpacity={1}
            onPress={cancelDatePicker}
          />
          <Animated.View
            style={[
              styles.datePickerContent,
              {
                transform: [{
                  scale: datePickerFadeAnim.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0.95, 1],
                  }),
                }],
              },
            ]}
          >
            <View style={styles.datePickerHeader}>
              <Text style={styles.pickerTitle}>Set Due Date</Text>
              <TouchableOpacity onPress={cancelDatePicker}>
                <X size={20} color={colors.muted} />
              </TouchableOpacity>
            </View>

            {/* Quick date options */}
            <View style={styles.quickDateOptions}>
              <TouchableOpacity
                style={styles.quickDateButton}
                onPress={() => {
                  if (editingCell) {
                    selectDateValue(editingCell.taskId, getDateOption('today'));
                  }
                }}
              >
                <Text style={styles.quickDateText}>Today</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.quickDateButton}
                onPress={() => {
                  if (editingCell) {
                    selectDateValue(editingCell.taskId, getDateOption('tomorrow'));
                  }
                }}
              >
                <Text style={styles.quickDateText}>Tomorrow</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.quickDateButton}
                onPress={() => {
                  if (editingCell) {
                    selectDateValue(editingCell.taskId, getDateOption('nextWeek'));
                  }
                }}
              >
                <Text style={styles.quickDateText}>Next week</Text>
              </TouchableOpacity>
            </View>

            {/* Simple Calendar */}
            <View style={styles.calendarContainer}>
              <View style={styles.calendarHeader}>
                <TouchableOpacity
                  style={styles.calendarNavButton}
                  onPress={() => setSelectedDate(new Date(selectedDate.getFullYear(), selectedDate.getMonth() - 1, 1))}
                >
                  <ChevronLeft size={20} color={colors.text} strokeWidth={2} />
                </TouchableOpacity>
                <Text style={styles.calendarMonthText}>
                  {selectedDate.toLocaleString('default', { month: 'long', year: 'numeric' })}
                </Text>
                <TouchableOpacity
                  style={styles.calendarNavButton}
                  onPress={() => setSelectedDate(new Date(selectedDate.getFullYear(), selectedDate.getMonth() + 1, 1))}
                >
                  <ChevronRight size={20} color={colors.text} strokeWidth={2} />
                </TouchableOpacity>
              </View>

              <View style={styles.calendarWeekdays}>
                {['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((day) => (
                  <Text key={day} style={styles.calendarWeekdayText}>{day}</Text>
                ))}
              </View>

              <View style={styles.calendarDays}>
                {(() => {
                  const year = selectedDate.getFullYear();
                  const month = selectedDate.getMonth();
                  const firstDay = new Date(year, month, 1).getDay();
                  const daysInMonth = new Date(year, month + 1, 0).getDate();
                  const days = [];

                  // Empty cells for days before month starts
                  for (let i = 0; i < firstDay; i++) {
                    days.push(<View key={`empty-${i}`} style={styles.calendarDay} />);
                  }

                  // Days of the month
                  for (let day = 1; day <= daysInMonth; day++) {
                    const date = new Date(year, month, day);
                    const isSelected = selectedDate.getDate() === day && selectedDate.getMonth() === month;
                    const isToday = new Date().toDateString() === date.toDateString();

                    days.push(
                      <TouchableOpacity
                        key={day}
                        style={styles.calendarDay}
                        onPress={() => setSelectedDate(new Date(year, month, day))}
                      >
                        <View style={[
                          styles.calendarDayInner,
                          isSelected && styles.calendarDaySelected,
                          isToday && !isSelected && styles.calendarDayToday,
                        ]}>
                          <Text style={[
                            styles.calendarDayText,
                            isSelected && styles.calendarDayTextSelected,
                            isToday && !isSelected && styles.calendarDayTextToday,
                          ]}>
                            {day}
                          </Text>
                        </View>
                      </TouchableOpacity>
                    );
                  }

                  return days;
                })()}
              </View>
            </View>

            {/* Footer buttons */}
            <View style={styles.datePickerFooter}>
              {tasks.find(t => t.id === editingCell?.taskId)?.dueDate && (
                <TouchableOpacity style={styles.clearDateButton} onPress={clearDate}>
                  <Text style={styles.clearDateText}>Clear</Text>
                </TouchableOpacity>
              )}
              <View style={styles.datePickerSpacer} />
              <View style={styles.datePickerActions}>
                <TouchableOpacity style={styles.cancelDateButton} onPress={cancelDatePicker}>
                  <Text style={styles.cancelDateText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.confirmDateButton} onPress={confirmDateSelection}>
                  <Text style={styles.confirmDateText}>Done</Text>
                </TouchableOpacity>
              </View>
            </View>
          </Animated.View>
        </Animated.View>
      </Modal>

      {/* Add Task Modal */}
      <Modal visible={showAddModal} transparent animationType="fade">
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.modalOverlay}
        >
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => setShowAddModal(false)}
          />
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>New task</Text>
              <TouchableOpacity onPress={() => setShowAddModal(false)}>
                <X size={20} color={colors.muted} />
              </TouchableOpacity>
            </View>
            <View style={styles.modalBody}>
              <Text style={styles.formLabel}>Title</Text>
              <TextInput
                style={styles.formInput}
                placeholder="Enter task title"
                placeholderTextColor="#A1A1AA"
                value={newTaskTitle}
                onChangeText={setNewTaskTitle}
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
                  !newTaskTitle.trim() && styles.createButtonDisabled,
                ]}
                onPress={handleAddTask}
                disabled={!newTaskTitle.trim()}
              >
                <Text style={styles.createButtonText}>Create task</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Text Input Modal */}
      <Modal visible={showTextInput} transparent animationType="fade">
        <Pressable style={styles.pickerOverlay} onPress={() => { setShowTextInput(false); setEditingCell(null); }}>
          <View style={styles.inputModalContent}>
            <View style={styles.pickerHeader}>
              <Text style={styles.pickerTitle}>Enter Text</Text>
              <TouchableOpacity onPress={() => { setShowTextInput(false); setEditingCell(null); }}>
                <X size={20} color={colors.muted} />
              </TouchableOpacity>
            </View>
            <View style={styles.inputModalBody}>
              <TextInput
                style={styles.modalTextInput}
                value={textInputValue}
                onChangeText={setTextInputValue}
                placeholder="Enter text..."
                placeholderTextColor={colors.muted}
                autoFocus
                multiline
              />
            </View>
            <View style={styles.inputModalFooter}>
              <TouchableOpacity style={styles.cancelDateButton} onPress={() => { setShowTextInput(false); setEditingCell(null); }}>
                <Text style={styles.cancelDateText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.confirmDateButton} onPress={saveTextInput}>
                <Text style={styles.confirmDateText}>Save</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Pressable>
      </Modal>

      {/* Number Input Modal */}
      <Modal visible={showNumberInput} transparent animationType="fade">
        <Pressable style={styles.pickerOverlay} onPress={() => { setShowNumberInput(false); setEditingCell(null); }}>
          <View style={styles.inputModalContent}>
            <View style={styles.pickerHeader}>
              <Text style={styles.pickerTitle}>Enter Number</Text>
              <TouchableOpacity onPress={() => { setShowNumberInput(false); setEditingCell(null); }}>
                <X size={20} color={colors.muted} />
              </TouchableOpacity>
            </View>
            <View style={styles.inputModalBody}>
              <TextInput
                style={styles.modalTextInput}
                value={numberInputValue}
                onChangeText={setNumberInputValue}
                placeholder="Enter number..."
                placeholderTextColor={colors.muted}
                keyboardType="numeric"
                autoFocus
              />
            </View>
            <View style={styles.inputModalFooter}>
              <TouchableOpacity style={styles.cancelDateButton} onPress={() => { setShowNumberInput(false); setEditingCell(null); }}>
                <Text style={styles.cancelDateText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.confirmDateButton} onPress={saveNumberInput}>
                <Text style={styles.confirmDateText}>Save</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Pressable>
      </Modal>

      {/* Single Select Modal */}
      <Modal visible={showSelectPicker} transparent animationType="fade">
        <Pressable style={styles.pickerOverlay} onPress={() => { setShowSelectPicker(false); setEditingCell(null); }}>
          <View style={styles.pickerContent}>
            <View style={styles.pickerHeader}>
              <Text style={styles.pickerTitle}>Select Option</Text>
              <TouchableOpacity onPress={() => { setShowSelectPicker(false); setEditingCell(null); }}>
                <X size={20} color={colors.muted} />
              </TouchableOpacity>
            </View>
            <View style={styles.pickerOptions}>
              {selectOptions.map((option) => {
                const isSelected = editingCell?.columnId && getCustomFieldValue(editingCell.taskId, editingCell.columnId) === option.id;
                return (
                  <TouchableOpacity
                    key={option.id}
                    style={[styles.pickerOption, isSelected && styles.pickerOptionSelected]}
                    onPress={() => selectOption(option.id)}
                  >
                    <View style={[styles.selectBadge, { backgroundColor: option.color + '20' }]}>
                      <Text style={[styles.selectBadgeText, { color: option.color }]}>{option.label}</Text>
                    </View>
                    {isSelected && <Check size={16} color={colors.primary} strokeWidth={2} />}
                  </TouchableOpacity>
                );
              })}
              <TouchableOpacity
                style={styles.pickerOption}
                onPress={() => {
                  if (editingCell?.columnId) {
                    setCustomFieldValue(editingCell.taskId, editingCell.columnId, null);
                  }
                  setShowSelectPicker(false);
                  setEditingCell(null);
                }}
              >
                <Text style={[styles.pickerOptionText, { color: '#EF4444' }]}>Clear</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Pressable>
      </Modal>

      {/* Multi Select Modal */}
      <Modal visible={showMultiSelectPicker} transparent animationType="fade">
        <Pressable style={styles.pickerOverlay} onPress={() => { setShowMultiSelectPicker(false); setEditingCell(null); }}>
          <View style={styles.pickerContent}>
            <View style={styles.pickerHeader}>
              <Text style={styles.pickerTitle}>Select Options</Text>
              <TouchableOpacity onPress={() => { setShowMultiSelectPicker(false); setEditingCell(null); }}>
                <X size={20} color={colors.muted} />
              </TouchableOpacity>
            </View>
            <View style={styles.pickerOptions}>
              {selectOptions.map((option) => {
                const selectedIds: string[] = editingCell?.columnId ? getCustomFieldValue(editingCell.taskId, editingCell.columnId) || [] : [];
                const isSelected = selectedIds.includes(option.id);
                return (
                  <TouchableOpacity
                    key={option.id}
                    style={[styles.pickerOption, isSelected && styles.pickerOptionSelected]}
                    onPress={() => toggleMultiSelectOption(option.id)}
                  >
                    <View style={[styles.selectBadge, { backgroundColor: option.color + '20' }]}>
                      <Text style={[styles.selectBadgeText, { color: option.color }]}>{option.label}</Text>
                    </View>
                    {isSelected && <Check size={16} color={colors.primary} strokeWidth={2} />}
                  </TouchableOpacity>
                );
              })}
            </View>
            <View style={styles.inputModalFooter}>
              <TouchableOpacity style={styles.confirmDateButton} onPress={() => { setShowMultiSelectPicker(false); setEditingCell(null); }}>
                <Text style={styles.confirmDateText}>Done</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Pressable>
      </Modal>

      {/* Tags Modal */}
      <Modal visible={showTagsPicker} transparent animationType="fade">
        <Pressable style={styles.pickerOverlay} onPress={() => { setShowTagsPicker(false); setEditingCell(null); }}>
          <View style={styles.tagsModalContent}>
            <View style={styles.pickerHeader}>
              <Text style={styles.pickerTitle}>Manage Tags</Text>
              <TouchableOpacity onPress={() => { setShowTagsPicker(false); setEditingCell(null); }}>
                <X size={20} color={colors.muted} />
              </TouchableOpacity>
            </View>
            <View style={styles.inputModalBody}>
              <View style={styles.tagInputRow}>
                <TextInput
                  style={styles.tagInputField}
                  value={newTagValue}
                  onChangeText={setNewTagValue}
                  placeholder="Add a tag..."
                  placeholderTextColor={colors.muted}
                  onSubmitEditing={addTag}
                />
                <TouchableOpacity style={styles.tagAddBtn} onPress={addTag}>
                  <Plus size={18} color={colors.text} strokeWidth={2} />
                </TouchableOpacity>
              </View>
              <View style={styles.currentTagsContainer}>
                {editingCell?.columnId && (getCustomFieldValue(editingCell.taskId, editingCell.columnId) || []).map((tag: string, idx: number) => (
                  <TouchableOpacity
                    key={idx}
                    style={styles.editableTag}
                    onPress={() => removeTag(tag)}
                  >
                    <Text style={styles.editableTagText}>{tag}</Text>
                    <X size={14} color={colors.muted} strokeWidth={2} />
                  </TouchableOpacity>
                ))}
              </View>
            </View>
            <View style={styles.inputModalFooter}>
              <TouchableOpacity style={styles.confirmDateButton} onPress={() => { setShowTagsPicker(false); setEditingCell(null); }}>
                <Text style={styles.confirmDateText}>Done</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Pressable>
      </Modal>

      {/* Column Options Modal */}
      <Modal visible={showColumnOptionsModal} transparent animationType="none">
        <Pressable
          style={styles.columnOptionsOverlay}
          onPress={() => {
            setShowColumnOptionsModal(false);
            setSelectedColumnForOptions(null);
          }}
        >
          <View style={styles.columnOptionsContent}>
            {/* Header */}
            <View style={styles.columnOptionsHeader}>
              <Text style={styles.columnOptionsTitle}>
                {availableColumns.find(c => c.id === selectedColumnForOptions)?.label || 'Column'}
              </Text>
            </View>

            {/* Options */}
            <View style={styles.columnOptionsBody}>
              {/* Move Left */}
              <Pressable
                style={({ pressed }) => [
                  styles.columnOptionItem,
                  pressed && styles.columnOptionItemPressed,
                  visibleColumns.indexOf(selectedColumnForOptions || '') === 0 && styles.columnOptionItemDisabled,
                ]}
                onPress={moveColumnLeft}
                disabled={visibleColumns.indexOf(selectedColumnForOptions || '') === 0}
              >
                <View style={styles.columnOptionIconWrapper}>
                  <ArrowLeft size={16} color={visibleColumns.indexOf(selectedColumnForOptions || '') === 0 ? '#D4D4D8' : '#71717A'} strokeWidth={2} />
                </View>
                <Text style={[
                  styles.columnOptionText,
                  visibleColumns.indexOf(selectedColumnForOptions || '') === 0 && styles.columnOptionTextDisabled,
                ]}>
                  Move left
                </Text>
              </Pressable>

              {/* Move Right */}
              <Pressable
                style={({ pressed }) => [
                  styles.columnOptionItem,
                  pressed && styles.columnOptionItemPressed,
                  visibleColumns.indexOf(selectedColumnForOptions || '') === visibleColumns.length - 1 && styles.columnOptionItemDisabled,
                ]}
                onPress={moveColumnRight}
                disabled={visibleColumns.indexOf(selectedColumnForOptions || '') === visibleColumns.length - 1}
              >
                <View style={styles.columnOptionIconWrapper}>
                  <ArrowRight size={16} color={visibleColumns.indexOf(selectedColumnForOptions || '') === visibleColumns.length - 1 ? '#D4D4D8' : '#71717A'} strokeWidth={2} />
                </View>
                <Text style={[
                  styles.columnOptionText,
                  visibleColumns.indexOf(selectedColumnForOptions || '') === visibleColumns.length - 1 && styles.columnOptionTextDisabled,
                ]}>
                  Move right
                </Text>
              </Pressable>

              {/* Separator */}
              <View style={styles.columnOptionSeparator} />

              {/* Hide Column */}
              <Pressable
                style={({ pressed }) => [
                  styles.columnOptionItem,
                  pressed && styles.columnOptionItemPressed,
                ]}
                onPress={hideColumn}
              >
                <View style={styles.columnOptionIconWrapper}>
                  <EyeOff size={16} color="#71717A" strokeWidth={2} />
                </View>
                <Text style={styles.columnOptionText}>Hide column</Text>
              </Pressable>

              {/* Delete Column */}
              <Pressable
                style={({ pressed }) => [
                  styles.columnOptionItem,
                  pressed && styles.columnOptionItemDangerPressed,
                ]}
                onPress={hideColumn}
              >
                <View style={styles.columnOptionIconWrapper}>
                  <Trash2 size={16} color="#EF4444" strokeWidth={2} />
                </View>
                <Text style={styles.columnOptionTextDanger}>Delete column</Text>
              </Pressable>
            </View>
          </View>
        </Pressable>
      </Modal>

      {/* Sort Modal */}
      <Modal visible={showSortModal} transparent animationType="none">
        <Pressable style={styles.columnOptionsOverlay} onPress={() => setShowSortModal(false)}>
          <View style={styles.sortFilterContent}>
            <View style={styles.sortFilterHeader}>
              <Text style={styles.sortFilterTitle}>Sort by</Text>
              {sortField && (
                <TouchableOpacity onPress={clearSort}>
                  <Text style={styles.clearButtonText}>Clear</Text>
                </TouchableOpacity>
              )}
            </View>
            <View style={styles.sortFilterBody}>
              {sortableFields.map((field) => (
                <Pressable
                  key={field.id}
                  style={({ pressed }) => [
                    styles.sortFilterItem,
                    pressed && styles.sortFilterItemPressed,
                    sortField === field.id && styles.sortFilterItemActive,
                  ]}
                  onPress={() => applySort(field.id)}
                >
                  <Text style={[
                    styles.sortFilterItemText,
                    sortField === field.id && styles.sortFilterItemTextActive,
                  ]}>
                    {field.label}
                  </Text>
                  {sortField === field.id && (
                    <View style={styles.sortDirectionIcon}>
                      {sortDirection === 'asc' ? (
                        <ArrowUp size={14} color="#3B82F6" strokeWidth={2} />
                      ) : (
                        <ArrowDown size={14} color="#3B82F6" strokeWidth={2} />
                      )}
                    </View>
                  )}
                </Pressable>
              ))}
            </View>
          </View>
        </Pressable>
      </Modal>

      {/* Filter Modal */}
      <Modal visible={showFilterModal} transparent animationType="none">
        <Pressable style={styles.columnOptionsOverlay} onPress={() => setShowFilterModal(false)}>
          <View style={styles.sortFilterContent}>
            <View style={styles.sortFilterHeader}>
              <Text style={styles.sortFilterTitle}>Filters</Text>
              {filters.length > 0 && (
                <TouchableOpacity onPress={clearFilters}>
                  <Text style={styles.clearButtonText}>Clear all</Text>
                </TouchableOpacity>
              )}
            </View>
            <View style={styles.sortFilterBody}>
              {/* Active filters */}
              {filters.length > 0 && (
                <View style={styles.activeFiltersContainer}>
                  {filters.map((filter, index) => (
                    <View key={index} style={styles.activeFilterChip}>
                      <Text style={styles.activeFilterText}>
                        {filterableFields.find(f => f.id === filter.field)?.label}: {filter.value}
                      </Text>
                      <TouchableOpacity onPress={() => removeFilter(index)}>
                        <X size={14} color="#71717A" strokeWidth={2} />
                      </TouchableOpacity>
                    </View>
                  ))}
                </View>
              )}

              {/* Add new filter */}
              <View style={styles.addFilterSection}>
                <Text style={styles.addFilterLabel}>Add filter</Text>
                <View style={styles.filterSelectRow}>
                  <View style={styles.filterFieldSelect}>
                    {filterableFields.map((field) => (
                      <Pressable
                        key={field.id}
                        style={[
                          styles.filterFieldOption,
                          filterField === field.id && styles.filterFieldOptionActive,
                        ]}
                        onPress={() => {
                          setFilterField(field.id);
                          setFilterValue('');
                        }}
                      >
                        <Text style={[
                          styles.filterFieldOptionText,
                          filterField === field.id && styles.filterFieldOptionTextActive,
                        ]}>
                          {field.label}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                </View>
                <View style={styles.filterValueSelect}>
                  {filterableFields.find(f => f.id === filterField)?.options.map((option) => (
                    <Pressable
                      key={option}
                      style={({ pressed }) => [
                        styles.filterValueOption,
                        pressed && styles.filterValueOptionPressed,
                        filterValue === option && styles.filterValueOptionActive,
                      ]}
                      onPress={() => setFilterValue(option)}
                    >
                      {filterField === 'status' && statusConfig[option] && (
                        <View style={[styles.filterBadge, { backgroundColor: statusConfig[option].bg }]}>
                          <Text style={[styles.filterBadgeText, { color: statusConfig[option].color }]}>
                            {statusConfig[option].label}
                          </Text>
                        </View>
                      )}
                      {filterField === 'priority' && priorityConfig[option] && (
                        <View style={[styles.filterBadge, { backgroundColor: priorityConfig[option].bg }]}>
                          <Text style={[styles.filterBadgeText, { color: priorityConfig[option].color }]}>
                            {priorityConfig[option].label}
                          </Text>
                        </View>
                      )}
                      {filterValue === option && (
                        <Check size={14} color="#3B82F6" strokeWidth={2} />
                      )}
                    </Pressable>
                  ))}
                </View>
                {filterValue && (
                  <TouchableOpacity style={styles.applyFilterButton} onPress={addFilter}>
                    <Text style={styles.applyFilterButtonText}>Apply filter</Text>
                  </TouchableOpacity>
                )}
              </View>
            </View>
          </View>
        </Pressable>
      </Modal>

      {/* View Settings Modal */}
      <Modal visible={showViewSettingsModal} transparent animationType="none">
        <Pressable style={styles.columnOptionsOverlay} onPress={() => setShowViewSettingsModal(false)}>
          <View style={styles.sortFilterContent}>
            <View style={styles.sortFilterHeader}>
              <Text style={styles.sortFilterTitle}>View settings</Text>
            </View>
            <View style={styles.sortFilterBody}>
              {/* Show completed tasks toggle */}
              <Pressable
                style={({ pressed }) => [
                  styles.viewSettingItem,
                  pressed && styles.sortFilterItemPressed,
                ]}
                onPress={() => setShowCompletedTasks(!showCompletedTasks)}
              >
                <View style={styles.viewSettingLeft}>
                  <Eye size={16} color="#71717A" strokeWidth={2} />
                  <Text style={styles.viewSettingText}>Show completed tasks</Text>
                </View>
                <View style={[styles.toggleSwitch, showCompletedTasks && styles.toggleSwitchActive]}>
                  <View style={[styles.toggleKnob, showCompletedTasks && styles.toggleKnobActive]} />
                </View>
              </Pressable>

              {/* Compact view toggle */}
              <Pressable
                style={({ pressed }) => [
                  styles.viewSettingItem,
                  pressed && styles.sortFilterItemPressed,
                ]}
                onPress={() => setCompactView(!compactView)}
              >
                <View style={styles.viewSettingLeft}>
                  <Columns3 size={16} color="#71717A" strokeWidth={2} />
                  <Text style={styles.viewSettingText}>Compact view</Text>
                </View>
                <View style={[styles.toggleSwitch, compactView && styles.toggleSwitchActive]}>
                  <View style={[styles.toggleKnob, compactView && styles.toggleKnobActive]} />
                </View>
              </Pressable>

              <View style={styles.columnOptionSeparator} />

              {/* Manage columns */}
              <Pressable
                style={({ pressed }) => [
                  styles.viewSettingItem,
                  pressed && styles.sortFilterItemPressed,
                ]}
                onPress={() => {
                  setShowViewSettingsModal(false);
                  setShowColumnPicker(true);
                }}
              >
                <View style={styles.viewSettingLeft}>
                  <Plus size={16} color="#71717A" strokeWidth={2} />
                  <Text style={styles.viewSettingText}>Manage columns</Text>
                </View>
                <ChevronRight size={16} color="#D4D4D8" strokeWidth={2} />
              </Pressable>
            </View>
          </View>
        </Pressable>
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
    gap: 8,
  },
  toolbarButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
  },
  toolbarButtonText: {
    fontSize: 13,
    color: colors.text,
    fontWeight: '500',
  },
  newTaskButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: colors.text,
  },
  newTaskButtonText: {
    fontSize: 13,
    color: '#FFFFFF',
    fontWeight: '500',
  },
  // Table
  tableWrapper: {
    flex: 1,
  },
  headerRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.background,
  },
  headerCell: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRightWidth: 1,
    borderRightColor: colors.border,
  },
  headerIcon: {
    fontSize: 14,
    color: colors.muted,
  },
  headerText: {
    fontSize: 13,
    color: colors.muted,
    fontWeight: '500',
  },
  dataRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  dataCell: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    justifyContent: 'center',
    borderRightWidth: 1,
    borderRightColor: colors.border,
  },
  // Column widths
  checkboxCell: {
    width: 120,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  addCell: {
    width: 80,
  },
  checkboxEmpty: {
    width: 18,
    height: 18,
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: colors.border,
  },
  checkboxBox: {
    width: 18,
    height: 18,
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: colors.border,
    justifyContent: 'center',
    alignItems: 'center',
  },
  checkboxChecked: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  cellTouchable: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'flex-start',
  },
  // Cell content styles
  cellText: {
    fontSize: 13,
    color: colors.text,
  },
  tagsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    flexWrap: 'wrap',
  },
  tagBadge: {
    backgroundColor: '#F3F4F6',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  tagText: {
    fontSize: 11,
    color: '#374151',
  },
  moreText: {
    fontSize: 11,
    color: colors.muted,
  },
  selectBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
  },
  selectBadgeText: {
    fontSize: 12,
    fontWeight: '500',
  },
  // Input modals
  inputModalContent: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: colors.card,
    borderRadius: 12,
    overflow: 'hidden',
  },
  inputModalBody: {
    padding: 16,
  },
  inputModalFooter: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  modalTextInput: {
    fontSize: 14,
    color: colors.text,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    minHeight: 44,
  },
  // Tags modal
  tagsModalContent: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: colors.card,
    borderRadius: 12,
    overflow: 'hidden',
  },
  tagInputRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 12,
  },
  tagInputField: {
    flex: 1,
    fontSize: 14,
    color: colors.text,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  tagAddBtn: {
    width: 44,
    height: 44,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  currentTagsContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  editableTag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#F3F4F6',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
  },
  editableTagText: {
    fontSize: 13,
    color: '#374151',
  },
  // Select cell
  cellSelected: {
    backgroundColor: '#EFF6FF',
  },
  selectText: {
    fontSize: 13,
    color: colors.muted,
  },
  selectTextSelected: {
    color: colors.primary,
    fontWeight: '500',
  },
  // Task
  taskTitle: {
    fontSize: 14,
    color: colors.text,
    fontWeight: '400',
  },
  // Badge
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
    alignSelf: 'flex-start',
  },
  badgeText: {
    fontSize: 12,
    fontWeight: '500',
  },
  // Assignee
  assigneeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  assigneeAvatar: {
    width: 20,
    height: 20,
    borderRadius: 4,
    backgroundColor: '#EF4444',
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarText: {
    fontSize: 10,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  assigneeName: {
    fontSize: 13,
    color: colors.text,
  },
  // Date
  dateText: {
    fontSize: 13,
    color: colors.text,
  },
  placeholderText: {
    fontSize: 13,
    color: colors.muted,
  },
  // Cell input
  cellInput: {
    fontSize: 14,
    color: colors.text,
    padding: 0,
    margin: 0,
    flex: 1,
  },
  // Picker modal
  pickerOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  pickerContent: {
    width: '100%',
    maxWidth: 320,
    backgroundColor: colors.card,
    borderRadius: 12,
    overflow: 'hidden',
  },
  pickerHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  pickerTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.text,
  },
  pickerOptions: {
    padding: 8,
  },
  pickerOption: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
  },
  pickerOptionSelected: {
    backgroundColor: colors.subtle,
  },
  pickerOptionText: {
    fontSize: 14,
    color: colors.text,
  },
  pickerOptionDanger: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    marginTop: 4,
    paddingTop: 12,
  },
  dateOptionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  // Date picker
  datePickerContent: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: colors.card,
    borderRadius: 12,
    overflow: 'hidden',
  },
  datePickerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  quickDateOptions: {
    flexDirection: 'row',
    gap: 8,
    padding: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  quickDateButton: {
    flex: 1,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 6,
    backgroundColor: colors.subtle,
    alignItems: 'center',
  },
  quickDateText: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.text,
  },
  calendarContainer: {
    padding: 12,
  },
  calendarHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  calendarNavButton: {
    padding: 8,
  },
  calendarMonthText: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.text,
  },
  calendarWeekdays: {
    flexDirection: 'row',
    marginBottom: 8,
  },
  calendarWeekdayText: {
    flex: 1,
    textAlign: 'center',
    fontSize: 12,
    fontWeight: '500',
    color: colors.muted,
  },
  calendarDays: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  calendarDay: {
    width: '14.28%',
    aspectRatio: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  calendarDayInner: {
    width: 32,
    height: 32,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 6,
  },
  calendarDaySelected: {
    backgroundColor: colors.primary,
  },
  calendarDayToday: {
    borderWidth: 1,
    borderColor: colors.primary,
  },
  calendarDayText: {
    fontSize: 14,
    color: colors.text,
  },
  calendarDayTextSelected: {
    color: '#FFFFFF',
    fontWeight: '600',
  },
  calendarDayTextToday: {
    color: colors.primary,
    fontWeight: '600',
  },
  datePickerFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  datePickerSpacer: {
    flex: 1,
  },
  datePickerActions: {
    flexDirection: 'row',
    gap: 12,
  },
  clearDateButton: {
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  clearDateText: {
    fontSize: 14,
    fontWeight: '500',
    color: '#EF4444',
  },
  cancelDateButton: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cancelDateText: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.muted,
  },
  confirmDateButton: {
    paddingVertical: 8,
    paddingHorizontal: 16,
    backgroundColor: colors.primary,
    borderRadius: 6,
  },
  confirmDateText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  // Task picker
  taskPickerContent: {
    width: '100%',
    maxWidth: 400,
    maxHeight: '70%',
    backgroundColor: colors.card,
    borderRadius: 12,
    overflow: 'hidden',
  },
  taskPickerList: {
    maxHeight: 400,
  },
  taskPickerItem: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  taskPickerItemDisabled: {
    opacity: 0.5,
  },
  taskPickerItemContent: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  taskPickerItemTitle: {
    flex: 1,
    fontSize: 14,
    color: colors.text,
    fontWeight: '500',
  },
  taskPickerItemTitleDisabled: {
    color: colors.muted,
  },
  alreadyAddedText: {
    fontSize: 12,
    color: colors.muted,
    marginTop: 4,
  },
  // Add row
  addRowButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  addRowText: {
    fontSize: 14,
    color: colors.muted,
  },
  // Column picker
  columnPickerContent: {
    width: '100%',
    maxWidth: 280,
    maxHeight: '70%',
    backgroundColor: colors.card,
    borderRadius: 12,
    overflow: 'hidden',
  },
  columnPickerScroll: {
    paddingHorizontal: 8,
    paddingBottom: 8,
  },
  columnPickerItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
  },
  columnPickerItemActive: {
    backgroundColor: colors.subtle,
  },
  columnPickerIconContainer: {
    width: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  columnPickerLabel: {
    flex: 1,
    fontSize: 14,
    color: colors.text,
  },
  columnPickerLabelActive: {
    fontWeight: '500',
  },
  // Empty
  emptyState: {
    padding: 40,
    alignItems: 'center',
  },
  emptyText: {
    fontSize: 14,
    color: colors.muted,
  },
  // Modal
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.8)',
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
  // Column Options Modal - shadcn style
  columnOptionsOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  columnOptionsContent: {
    width: '100%',
    maxWidth: 220,
    backgroundColor: '#FFFFFF',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#E4E4E7',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 12,
    elevation: 8,
    overflow: 'hidden',
  },
  columnOptionsHeader: {
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 6,
  },
  columnOptionsTitle: {
    fontSize: 12,
    fontWeight: '500',
    color: '#71717A',
    letterSpacing: 0.3,
  },
  columnOptionsBody: {
    paddingVertical: 4,
    paddingHorizontal: 4,
  },
  columnOptionItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 8,
    paddingVertical: 8,
    borderRadius: 6,
  },
  columnOptionItemPressed: {
    backgroundColor: '#F4F4F5',
  },
  columnOptionItemDangerPressed: {
    backgroundColor: '#FEF2F2',
  },
  columnOptionItemDisabled: {
    opacity: 0.5,
  },
  columnOptionIconWrapper: {
    width: 20,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  columnOptionText: {
    fontSize: 14,
    color: '#18181B',
    fontWeight: '400',
  },
  columnOptionTextDisabled: {
    color: '#A1A1AA',
  },
  columnOptionTextDanger: {
    fontSize: 14,
    color: '#EF4444',
    fontWeight: '400',
  },
  columnOptionSeparator: {
    height: 1,
    backgroundColor: '#E4E4E7',
    marginVertical: 4,
    marginHorizontal: 4,
  },
  // Toolbar button active states
  toolbarButtonActive: {
    backgroundColor: '#EFF6FF',
    borderColor: '#3B82F6',
  },
  toolbarButtonTextActive: {
    color: '#3B82F6',
  },
  // Sort & Filter Modal styles
  sortFilterContent: {
    width: '100%',
    maxWidth: 280,
    backgroundColor: '#FFFFFF',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#E4E4E7',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 12,
    elevation: 8,
    overflow: 'hidden',
  },
  sortFilterHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#E4E4E7',
  },
  sortFilterTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#18181B',
  },
  clearButtonText: {
    fontSize: 13,
    color: '#3B82F6',
    fontWeight: '500',
  },
  sortFilterBody: {
    paddingVertical: 4,
    paddingHorizontal: 4,
  },
  sortFilterItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
    paddingVertical: 10,
    borderRadius: 6,
  },
  sortFilterItemPressed: {
    backgroundColor: '#F4F4F5',
  },
  sortFilterItemActive: {
    backgroundColor: '#EFF6FF',
  },
  sortFilterItemText: {
    fontSize: 14,
    color: '#18181B',
    fontWeight: '400',
  },
  sortFilterItemTextActive: {
    color: '#3B82F6',
    fontWeight: '500',
  },
  sortDirectionIcon: {
    width: 20,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Filter specific styles
  activeFiltersContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#E4E4E7',
    marginBottom: 4,
  },
  activeFilterChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#F4F4F5',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
  },
  activeFilterText: {
    fontSize: 12,
    color: '#18181B',
  },
  addFilterSection: {
    paddingHorizontal: 8,
    paddingVertical: 8,
  },
  addFilterLabel: {
    fontSize: 12,
    fontWeight: '500',
    color: '#71717A',
    marginBottom: 8,
  },
  filterSelectRow: {
    marginBottom: 8,
  },
  filterFieldSelect: {
    flexDirection: 'row',
    gap: 6,
  },
  filterFieldOption: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#E4E4E7',
    backgroundColor: '#FFFFFF',
  },
  filterFieldOptionActive: {
    borderColor: '#3B82F6',
    backgroundColor: '#EFF6FF',
  },
  filterFieldOptionText: {
    fontSize: 13,
    color: '#71717A',
    fontWeight: '500',
  },
  filterFieldOptionTextActive: {
    color: '#3B82F6',
  },
  filterValueSelect: {
    gap: 4,
  },
  filterValueOption: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
    paddingVertical: 8,
    borderRadius: 6,
  },
  filterValueOptionPressed: {
    backgroundColor: '#F4F4F5',
  },
  filterValueOptionActive: {
    backgroundColor: '#EFF6FF',
  },
  filterBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
  },
  filterBadgeText: {
    fontSize: 12,
    fontWeight: '500',
  },
  applyFilterButton: {
    marginTop: 12,
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: '#18181B',
    borderRadius: 6,
    alignItems: 'center',
  },
  applyFilterButtonText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  // View Settings styles
  viewSettingItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
    paddingVertical: 10,
    borderRadius: 6,
  },
  viewSettingLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  viewSettingText: {
    fontSize: 14,
    color: '#18181B',
    fontWeight: '400',
  },
  toggleSwitch: {
    width: 40,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#E4E4E7',
    padding: 2,
    justifyContent: 'center',
  },
  toggleSwitchActive: {
    backgroundColor: '#3B82F6',
  },
  toggleKnob: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: '#FFFFFF',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.15,
    shadowRadius: 2,
    elevation: 2,
  },
  toggleKnobActive: {
    alignSelf: 'flex-end',
  },
});
