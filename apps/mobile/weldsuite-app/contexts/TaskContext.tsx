import React, { createContext, useContext, useState, useCallback, ReactNode } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import api from '../services/api';
import type {
  TaskItem,
  TaskStats,
  TaskDashboardData,
  Project,
  Tag,
  Workflow,
  WorkflowStats,
  Execution,
  Schedule,
  TaskFilters,
} from '../types/task.types';

// ============================================================================
// TYPES
// ============================================================================

interface TaskState {
  // Personal Tasks
  tasks: TaskItem[];
  taskStats: TaskStats | null;
  dashboardData: TaskDashboardData | null;
  projects: Project[];
  tags: Tag[];

  // Workflows
  workflows: Workflow[];
  workflowStats: WorkflowStats | null;
  executions: Execution[];
  schedules: Schedule[];

  // Cache timestamps
  lastTasksUpdate: number | null;
  lastDashboardUpdate: number | null;
  lastWorkflowsUpdate: number | null;

  // Loading states
  loading: {
    tasks: boolean;
    dashboard: boolean;
    projects: boolean;
    workflows: boolean;
    executions: boolean;
  };

  // Errors
  errors: {
    tasks: string | null;
    dashboard: string | null;
    projects: string | null;
    workflows: string | null;
    executions: string | null;
  };

  // Offline queue
  offlineQueue: OfflineAction[];
}

interface OfflineAction {
  id: string;
  type: 'create_task' | 'update_task' | 'delete_task' | 'toggle_complete' | 'toggle_important';
  payload: any;
  timestamp: number;
}

interface TaskContextValue extends TaskState {
  // Dashboard
  loadDashboard: (force?: boolean) => Promise<void>;
  refreshDashboard: () => Promise<void>;

  // Tasks
  loadTasks: (filters?: TaskFilters, force?: boolean) => Promise<void>;
  createTask: (data: any) => Promise<boolean>;
  updateTask: (id: string, data: any) => Promise<boolean>;
  deleteTask: (id: string) => Promise<boolean>;
  toggleTaskComplete: (id: string) => Promise<boolean>;
  toggleTaskImportant: (id: string) => Promise<boolean>;

  // Projects
  loadProjects: () => Promise<void>;
  createProject: (data: any) => Promise<boolean>;

  // Tags
  loadTags: () => Promise<void>;

  // Workflows
  loadWorkflows: (force?: boolean) => Promise<void>;
  loadWorkflowStats: () => Promise<void>;

  // Executions
  loadExecutions: (workflowId?: string) => Promise<void>;

  // Schedules
  loadSchedules: () => Promise<void>;

  // Cache management
  clearCache: () => Promise<void>;
  isDataStale: (lastUpdate: number | null, maxAge?: number) => boolean;

  // Offline queue
  addToOfflineQueue: (action: Omit<OfflineAction, 'id' | 'timestamp'>) => Promise<void>;
  processOfflineQueue: () => Promise<void>;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const STORAGE_KEYS = {
  TASKS: '@task_tasks',
  DASHBOARD: '@task_dashboard',
  PROJECTS: '@task_projects',
  TAGS: '@task_tags',
  WORKFLOWS: '@task_workflows',
  OFFLINE_QUEUE: '@task_offline_queue',
};

const CACHE_DURATION = {
  TASKS: 2 * 60 * 1000, // 2 minutes
  DASHBOARD: 5 * 60 * 1000, // 5 minutes
  WORKFLOWS: 5 * 60 * 1000, // 5 minutes
  PROJECTS: 30 * 60 * 1000, // 30 minutes
};

// ============================================================================
// CONTEXT
// ============================================================================

const TaskContext = createContext<TaskContextValue | undefined>(undefined);

// ============================================================================
// PROVIDER
// ============================================================================

export function TaskProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<TaskState>({
    tasks: [],
    taskStats: null,
    dashboardData: null,
    projects: [],
    tags: [],
    workflows: [],
    workflowStats: null,
    executions: [],
    schedules: [],
    lastTasksUpdate: null,
    lastDashboardUpdate: null,
    lastWorkflowsUpdate: null,
    loading: {
      tasks: false,
      dashboard: false,
      projects: false,
      workflows: false,
      executions: false,
    },
    errors: {
      tasks: null,
      dashboard: null,
      projects: null,
      workflows: null,
      executions: null,
    },
    offlineQueue: [],
  });

  // Utility function to check if data is stale
  const isDataStale = useCallback((lastUpdate: number | null, maxAge: number = CACHE_DURATION.DASHBOARD): boolean => {
    if (!lastUpdate) return true;
    return Date.now() - lastUpdate > maxAge;
  }, []);

  // ============================================================================
  // DASHBOARD
  // ============================================================================

  const loadDashboard = useCallback(async (force: boolean = false) => {
    if (!force && !isDataStale(state.lastDashboardUpdate, CACHE_DURATION.DASHBOARD)) {
      return;
    }

    setState(prev => ({
      ...prev,
      loading: { ...prev.loading, dashboard: true },
      errors: { ...prev.errors, dashboard: null },
    }));

    try {
      const response = await api.getTaskDashboard();
      if (response.success && response.data) {
        setState(prev => ({
          ...prev,
          dashboardData: response.data,
          lastDashboardUpdate: Date.now(),
          loading: { ...prev.loading, dashboard: false },
        }));
        await AsyncStorage.setItem(STORAGE_KEYS.DASHBOARD, JSON.stringify(response.data));
      } else {
        throw new Error(response.error || 'Failed to load dashboard');
      }
    } catch (error) {
      setState(prev => ({
        ...prev,
        loading: { ...prev.loading, dashboard: false },
        errors: { ...prev.errors, dashboard: error instanceof Error ? error.message : 'Unknown error' },
      }));
    }
  }, [state.lastDashboardUpdate, isDataStale]);

  const refreshDashboard = useCallback(async () => {
    await loadDashboard(true);
  }, [loadDashboard]);

  // ============================================================================
  // TASKS
  // ============================================================================

  const loadTasks = useCallback(async (filters?: TaskFilters, force: boolean = false) => {
    if (!force && !isDataStale(state.lastTasksUpdate, CACHE_DURATION.TASKS)) {
      return;
    }

    setState(prev => ({
      ...prev,
      loading: { ...prev.loading, tasks: true },
      errors: { ...prev.errors, tasks: null },
    }));

    try {
      const response = await api.getTasks(filters);
      if (response.success && response.data) {
        const tasks = response.data.items || response.data;
        setState(prev => ({
          ...prev,
          tasks: Array.isArray(tasks) ? tasks : [],
          lastTasksUpdate: Date.now(),
          loading: { ...prev.loading, tasks: false },
        }));
      } else {
        throw new Error(response.error || 'Failed to load tasks');
      }
    } catch (error) {
      setState(prev => ({
        ...prev,
        loading: { ...prev.loading, tasks: false },
        errors: { ...prev.errors, tasks: error instanceof Error ? error.message : 'Unknown error' },
      }));
    }
  }, [state.lastTasksUpdate, isDataStale]);

  const createTask = useCallback(async (data: any): Promise<boolean> => {
    try {
      const response = await api.createTask(data);
      if (response.success) {
        await loadTasks({}, true);
        return true;
      }
      return false;
    } catch (error) {
      console.error('Failed to create task:', error);
      // Add to offline queue
      await addToOfflineQueue({ type: 'create_task', payload: data });
      return false;
    }
  }, [loadTasks]);

  const updateTask = useCallback(async (id: string, data: any): Promise<boolean> => {
    try {
      const response = await api.updateTask(id, data);
      if (response.success) {
        setState(prev => ({
          ...prev,
          tasks: prev.tasks.map(t => t.id === id ? { ...t, ...data } : t),
        }));
        return true;
      }
      return false;
    } catch (error) {
      console.error('Failed to update task:', error);
      await addToOfflineQueue({ type: 'update_task', payload: { id, data } });
      return false;
    }
  }, []);

  const deleteTask = useCallback(async (id: string): Promise<boolean> => {
    try {
      const response = await api.deleteTask(id);
      if (response.success) {
        setState(prev => ({
          ...prev,
          tasks: prev.tasks.filter(t => t.id !== id),
        }));
        return true;
      }
      return false;
    } catch (error) {
      console.error('Failed to delete task:', error);
      await addToOfflineQueue({ type: 'delete_task', payload: { id } });
      return false;
    }
  }, []);

  const toggleTaskComplete = useCallback(async (id: string): Promise<boolean> => {
    try {
      const response = await api.toggleTaskComplete(id);
      if (response.success) {
        setState(prev => ({
          ...prev,
          tasks: prev.tasks.map(t =>
            t.id === id
              ? { ...t, status: t.status === 'completed' ? 'todo' : 'completed' as any }
              : t
          ),
        }));
        return true;
      }
      return false;
    } catch (error) {
      console.error('Failed to toggle task complete:', error);
      await addToOfflineQueue({ type: 'toggle_complete', payload: { id } });
      return false;
    }
  }, []);

  const toggleTaskImportant = useCallback(async (id: string): Promise<boolean> => {
    try {
      const response = await api.toggleTaskImportant(id);
      if (response.success) {
        setState(prev => ({
          ...prev,
          tasks: prev.tasks.map(t =>
            t.id === id ? { ...t, isImportant: !t.isImportant } : t
          ),
        }));
        return true;
      }
      return false;
    } catch (error) {
      console.error('Failed to toggle task important:', error);
      await addToOfflineQueue({ type: 'toggle_important', payload: { id } });
      return false;
    }
  }, []);

  // ============================================================================
  // PROJECTS
  // ============================================================================

  const loadProjects = useCallback(async () => {
    setState(prev => ({
      ...prev,
      loading: { ...prev.loading, projects: true },
      errors: { ...prev.errors, projects: null },
    }));

    try {
      const response = await api.getTaskProjects();
      if (response.success && response.data) {
        const projects = response.data.items || response.data;
        setState(prev => ({
          ...prev,
          projects: Array.isArray(projects) ? projects : [],
          loading: { ...prev.loading, projects: false },
        }));
      } else {
        throw new Error(response.error || 'Failed to load projects');
      }
    } catch (error) {
      setState(prev => ({
        ...prev,
        loading: { ...prev.loading, projects: false },
        errors: { ...prev.errors, projects: error instanceof Error ? error.message : 'Unknown error' },
      }));
    }
  }, []);

  const createProject = useCallback(async (data: any): Promise<boolean> => {
    try {
      const response = await api.createTaskProject(data);
      if (response.success) {
        await loadProjects();
        return true;
      }
      return false;
    } catch (error) {
      console.error('Failed to create project:', error);
      return false;
    }
  }, [loadProjects]);

  // ============================================================================
  // TAGS
  // ============================================================================

  const loadTags = useCallback(async () => {
    try {
      const response = await api.getTaskTags();
      if (response.success && response.data) {
        const tags = response.data.items || response.data;
        setState(prev => ({
          ...prev,
          tags: Array.isArray(tags) ? tags : [],
        }));
      }
    } catch (error) {
      console.error('Failed to load tags:', error);
    }
  }, []);

  // ============================================================================
  // WORKFLOWS
  // ============================================================================

  const loadWorkflows = useCallback(async (force: boolean = false) => {
    if (!force && !isDataStale(state.lastWorkflowsUpdate, CACHE_DURATION.WORKFLOWS)) {
      return;
    }

    setState(prev => ({
      ...prev,
      loading: { ...prev.loading, workflows: true },
      errors: { ...prev.errors, workflows: null },
    }));

    try {
      const response = await api.getWorkflows();
      if (response.success && response.data) {
        const workflows = response.data.items || response.data;
        setState(prev => ({
          ...prev,
          workflows: Array.isArray(workflows) ? workflows : [],
          lastWorkflowsUpdate: Date.now(),
          loading: { ...prev.loading, workflows: false },
        }));
      } else {
        throw new Error(response.error || 'Failed to load workflows');
      }
    } catch (error) {
      setState(prev => ({
        ...prev,
        loading: { ...prev.loading, workflows: false },
        errors: { ...prev.errors, workflows: error instanceof Error ? error.message : 'Unknown error' },
      }));
    }
  }, [state.lastWorkflowsUpdate, isDataStale]);

  const loadWorkflowStats = useCallback(async () => {
    try {
      const response = await api.getWorkflowStats();
      if (response.success && response.data) {
        setState(prev => ({
          ...prev,
          workflowStats: response.data,
        }));
      }
    } catch (error) {
      console.error('Failed to load workflow stats:', error);
    }
  }, []);

  // ============================================================================
  // EXECUTIONS
  // ============================================================================

  const loadExecutions = useCallback(async (workflowId?: string) => {
    setState(prev => ({
      ...prev,
      loading: { ...prev.loading, executions: true },
      errors: { ...prev.errors, executions: null },
    }));

    try {
      const response = await api.getExecutions({ workflowId });
      if (response.success && response.data) {
        const executions = response.data.items || response.data;
        setState(prev => ({
          ...prev,
          executions: Array.isArray(executions) ? executions : [],
          loading: { ...prev.loading, executions: false },
        }));
      } else {
        throw new Error(response.error || 'Failed to load executions');
      }
    } catch (error) {
      setState(prev => ({
        ...prev,
        loading: { ...prev.loading, executions: false },
        errors: { ...prev.errors, executions: error instanceof Error ? error.message : 'Unknown error' },
      }));
    }
  }, []);

  // ============================================================================
  // SCHEDULES
  // ============================================================================

  const loadSchedules = useCallback(async () => {
    try {
      const response = await api.getSchedules();
      if (response.success && response.data) {
        const schedules = response.data.items || response.data;
        setState(prev => ({
          ...prev,
          schedules: Array.isArray(schedules) ? schedules : [],
        }));
      }
    } catch (error) {
      console.error('Failed to load schedules:', error);
    }
  }, []);

  // ============================================================================
  // CACHE MANAGEMENT
  // ============================================================================

  const clearCache = useCallback(async () => {
    await Promise.all([
      AsyncStorage.removeItem(STORAGE_KEYS.TASKS),
      AsyncStorage.removeItem(STORAGE_KEYS.DASHBOARD),
      AsyncStorage.removeItem(STORAGE_KEYS.PROJECTS),
      AsyncStorage.removeItem(STORAGE_KEYS.TAGS),
      AsyncStorage.removeItem(STORAGE_KEYS.WORKFLOWS),
    ]);

    setState(prev => ({
      ...prev,
      tasks: [],
      dashboardData: null,
      projects: [],
      tags: [],
      workflows: [],
      executions: [],
      schedules: [],
      lastTasksUpdate: null,
      lastDashboardUpdate: null,
      lastWorkflowsUpdate: null,
    }));
  }, []);

  // ============================================================================
  // OFFLINE QUEUE
  // ============================================================================

  const addToOfflineQueue = useCallback(async (action: Omit<OfflineAction, 'id' | 'timestamp'>) => {
    const newAction: OfflineAction = {
      ...action,
      id: `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: Date.now(),
    };

    setState(prev => ({
      ...prev,
      offlineQueue: [...prev.offlineQueue, newAction],
    }));

    // Persist to storage
    const updatedQueue = [...state.offlineQueue, newAction];
    await AsyncStorage.setItem(STORAGE_KEYS.OFFLINE_QUEUE, JSON.stringify(updatedQueue));
  }, [state.offlineQueue]);

  const processOfflineQueue = useCallback(async () => {
    if (state.offlineQueue.length === 0) return;

    const queue = [...state.offlineQueue];
    const failedActions: OfflineAction[] = [];

    for (const action of queue) {
      try {
        switch (action.type) {
          case 'create_task':
            await api.createTask(action.payload);
            break;
          case 'update_task':
            await api.updateTask(action.payload.id, action.payload.data);
            break;
          case 'delete_task':
            await api.deleteTask(action.payload.id);
            break;
          case 'toggle_complete':
            await api.toggleTaskComplete(action.payload.id);
            break;
          case 'toggle_important':
            await api.toggleTaskImportant(action.payload.id);
            break;
        }
      } catch (error) {
        console.error(`Failed to process offline action ${action.type}:`, error);
        failedActions.push(action);
      }
    }

    setState(prev => ({
      ...prev,
      offlineQueue: failedActions,
    }));

    await AsyncStorage.setItem(STORAGE_KEYS.OFFLINE_QUEUE, JSON.stringify(failedActions));

    // Refresh data after processing queue
    if (failedActions.length < queue.length) {
      await loadTasks({}, true);
    }
  }, [state.offlineQueue, loadTasks]);

  // ============================================================================
  // CONTEXT VALUE
  // ============================================================================

  const value: TaskContextValue = {
    ...state,
    loadDashboard,
    refreshDashboard,
    loadTasks,
    createTask,
    updateTask,
    deleteTask,
    toggleTaskComplete,
    toggleTaskImportant,
    loadProjects,
    createProject,
    loadTags,
    loadWorkflows,
    loadWorkflowStats,
    loadExecutions,
    loadSchedules,
    clearCache,
    isDataStale,
    addToOfflineQueue,
    processOfflineQueue,
  };

  return <TaskContext.Provider value={value}>{children}</TaskContext.Provider>;
}

// ============================================================================
// HOOK
// ============================================================================

export function useTask() {
  const context = useContext(TaskContext);
  if (context === undefined) {
    throw new Error('useTask must be used within a TaskProvider');
  }
  return context;
}

export default TaskContext;
