
import { useState, useRef, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@weldsuite/ui/components/button';
import { CommentInput } from '@weldsuite/ui/components/comment-input';
import { type Comment } from '@weldsuite/ui/components/entity-detail-panel';
import { toast } from 'sonner';
import { useProjectPermissions } from '@/app/weldflow/contexts/project-permission-context';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { FilterPills, type ActiveFilter, type FilterConfig } from '@/components/entity-list';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@weldsuite/ui/components/command';
import { Tabs, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { Avatar, AvatarFallback } from '@weldsuite/ui/components/avatar';
import {
  Search,
  ChevronDown,
  Plus,
  Target,
  Users,
  Building2,
  User,
  MoreHorizontal,
  CheckCircle2,
  AlertCircle,
  XCircle,
  Clock,
  TrendingUp,
  MessageSquare,
  Paperclip,
  Flag,
  Trash2,
  MousePointer2,
  Hand,
  X,
  Share2,
  Link2,
  Maximize,
  Check,
  Send,
  AtSign,
  Image,
  Settings,
  ArrowUp,
  Minus,
  ChevronsUpDown,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTranslations } from '@weldsuite/i18n/client';
import { TagLabel } from '@/components/weldflow/tag-label';
import { TaskDetailPanel } from '@/components/task-detail';
import { useObjectPanel } from '@/components/object-panel';
import type { Task as CrmTask } from '@/hooks/use-crm-tasks';

// Types for goals data
interface MissionCardType {
  id: string;
  title: string;
  description: string;
  x: number;
  y: number;
  width: number;
  height: number;
  subGoals?: string[];
}

interface GoalCardType {
  id: string;
  title: string;
  description?: string;
  owner: {
    name: string;
    avatar?: string;
    initials: string;
    color: string;
  };
  status: 'on-track' | 'at-risk' | 'off-track' | 'not-started' | 'completed';
  progress: number;
  dueDate: string | Date;
  timePeriod: string;
  type: 'company' | 'team' | 'individual';
  x: number;
  y: number;
  width: number;
  height: number;
  parentId?: string;
  subGoals?: string[];
  metrics?: {
    target: number;
    current: number;
    unit: string;
  };
  updates?: number;
  comments?: number;
  attachments?: number;
  priority?: 'low' | 'medium' | 'high' | 'critical';
  linkedTaskId?: string;
}

interface GoalsData {
  mission?: MissionCardType;
  goals: GoalCardType[];
}

interface GoalComment extends Comment {
  goalId: string;
}

interface GoalCard {
  id: string;
  title: string;
  description?: string;
  owner: {
    name: string;
    avatar?: string;
    initials: string;
    color: string;
  };
  status: 'on-track' | 'at-risk' | 'off-track' | 'not-started' | 'completed';
  progress: number;
  dueDate: Date;
  timePeriod: string;
  type: 'company' | 'team' | 'individual';
  x: number;
  y: number;
  width: number;
  height: number;
  parentId?: string;
  subGoals?: string[];
  metrics?: {
    target: number;
    current: number;
    unit: string;
  };
  updates?: number;
  comments?: number;
  attachments?: number;
  priority?: 'low' | 'medium' | 'high' | 'critical';
  linkedTaskId?: string;
}

interface MissionCard {
  id: string;
  title: string;
  description: string;
  x: number;
  y: number;
  width: number;
  height: number;
  subGoals?: string[];
}

// Alignment threshold in pixels
const ALIGNMENT_THRESHOLD = 8;

interface AlignmentGuide {
  x: number;
  type: 'center' | 'left' | 'right';
  yStart: number;
  yEnd: number;
}

interface ExistingTask {
  id: string;
  title: string;
  projectName?: string;
  priority?: string;
}

// Match the sidebar square color in apps/web/platform/app/weldflow/project/[projectId]/gantt/page.tsx
// which uses priorityTextColors (the `-600` Tailwind variants).
const TASK_PRIORITY_COLORS: Record<string, string> = {
  low: '#4b5563',      // gray-600
  medium: '#2563eb',   // blue-600
  high: '#ea580c',     // orange-600
  urgent: '#dc2626',   // red-600
  critical: '#dc2626', // red-600
};
const TASK_NO_PRIORITY_COLOR = '#4b5563'; // gray-600

interface GoalsCanvasViewProps {
  projectId: string;
  initialGoalsData: GoalsData;
  initialTasks?: ExistingTask[];
}

export function GoalsCanvasView({ projectId, initialGoalsData, initialTasks = [] }: GoalsCanvasViewProps) {
  const st = useTranslations();
  const { canWrite } = useProjectPermissions();
  const { getClient } = useAppApiClient();
  const { open: openObjectPanel } = useObjectPanel();
  const canvasRef = useRef<HTMLDivElement>(null);
  const [existingTasks] = useState<ExistingTask[]>(initialTasks);

  // Convert dates from server (strings) to Date objects
  const initialGoals = initialGoalsData.goals.map(goal => ({
    ...goal,
    dueDate: typeof goal.dueDate === 'string' ? new Date(goal.dueDate) : goal.dueDate
  })) as GoalCard[];

  const [mission, setMission] = useState<MissionCard>(initialGoalsData.mission || {
    id: 'mission-1',
    title: 'My workspace',
    description: 'Our mission',
    x: 600,
    y: 50,
    width: 320,
    height: 160,
    subGoals: []
  });
  const [goals, setGoals] = useState<GoalCard[]>(initialGoals);
  const [isSaving, setIsSaving] = useState(false);
  const [selectedGoal, setSelectedGoal] = useState<string | null>(null);
  const [showDetailsPanel, setShowDetailsPanel] = useState(false);
  const [collapsedGoals, setCollapsedGoals] = useState<Set<string>>(new Set());
  const [hoveredGoal, setHoveredGoal] = useState<string | null>(null);
  const [showAddChildModal, setShowAddChildModal] = useState(false);
  const [showCreateGoalModal, setShowCreateGoalModal] = useState(false);
  const [showDeleteConfirmModal, setShowDeleteConfirmModal] = useState(false);
  const [goalToDelete, setGoalToDelete] = useState<string | null>(null);
  const [parentGoalForNewChild, setParentGoalForNewChild] = useState<string | null>(null);
  const [newGoalTitle, setNewGoalTitle] = useState('');
  const [newGoalTarget, setNewGoalTarget] = useState('');
  const [activeCommentsTab, setActiveCommentsTab] = useState<'comments' | 'activity'>('comments');
  const [goalCreationType, setGoalCreationType] = useState<'new' | 'existing'>('existing');
  const [selectedExistingTask, setSelectedExistingTask] = useState<string | null>(null);
  const [taskPickerOpen, setTaskPickerOpen] = useState(false);
  const [completedGoals, setCompletedGoals] = useState<Set<string>>(new Set());
  // Seeded with a placeholder so the goal-mode TaskDetailPanel stays mounted
  // from first render in a closed state (translate-x-full). On first open,
  // isOpen goes false → true, which triggers the slide-in transition.
  const lastShownPanelTaskRef = useRef<CrmTask>({
    id: '',
    title: '',
    status: 'todo',
    createdAt: new Date(),
  });
  const [commentInput, setCommentInput] = useState('');
  const [comments, setComments] = useState<GoalComment[]>([]);
  const [commentsHeight, setCommentsHeight] = useState(250);
  const [tool, setTool] = useState<'select' | 'pan'>('select');
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });
  const lastTouchRef = useRef<{ x: number; y: number } | null>(null);
  const panPositionRef = useRef({ x: 0, y: 0 });
  const touchRafRef = useRef<number | null>(null);

  // Start with { x: 0, y: 0 } to avoid hydration mismatch - will center in useEffect
  const [panPosition, setPanPosition] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [zoomIndex, setZoomIndex] = useState(8);
  const zoomLevels = [0.025, 0.05, 0.1, 0.15, 0.25, 0.33, 0.5, 0.75, 1, 1.5, 2, 3, 4, 5];
  const [isDragging, setIsDragging] = useState(false);
  const [draggedGoal, setDraggedGoal] = useState<string | null>(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [dragRenderTrigger, setDragRenderTrigger] = useState(0);
  const dragStartMouse = useRef({ x: 0, y: 0 });
  const dragStartGoal = useRef({ x: 0, y: 0 });
  const dragCurrentPosition = useRef({ x: 0, y: 0 });
  const draggedElementRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const hasDraggedRef = useRef(false);
  const [alignmentGuides, setAlignmentGuides] = useState<AlignmentGuide[]>([]);
  const [selectedTimePeriod, setSelectedTimePeriod] = useState('all');
  const [highlightStatus, setHighlightStatus] = useState<string>('none');
  const [showConnections, setShowConnections] = useState(true);
  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [isZooming, setIsZooming] = useState(false);
  const [isInitialLoad, setIsInitialLoad] = useState(true);

  // Focus search input when opened
  useEffect(() => {
    if (searchOpen && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [searchOpen]);

  // Filter configurations
  const filterConfigs: FilterConfig[] = useMemo(() => [
    {
      field: 'status',
      label: 'Status',
      options: [
        { value: 'on-track', label: 'On Track' },
        { value: 'at-risk', label: 'At Risk' },
        { value: 'off-track', label: 'Off Track' },
        { value: 'not-started', label: 'Not Started' },
        { value: 'completed', label: 'Completed' },
      ],
    },
    {
      field: 'timePeriod',
      label: 'Time Period',
      options: [
        { value: 'Q1 2024', label: 'Q1 2024' },
        { value: 'Q2 2024', label: 'Q2 2024' },
        { value: 'Q3 2024', label: 'Q3 2024' },
        { value: 'Q4 2024', label: 'Q4 2024' },
        { value: 'FY 2024', label: 'FY 2024' },
        { value: 'FY 2025', label: 'FY 2025' },
      ],
    },
    {
      field: 'owner',
      label: 'Owner',
      options: Array.from(new Set(goals.map(g => g.owner.name))).map(name => ({ value: name, label: name })),
    },
  ], [goals]);

  // Auto-organize goals into a proper tree layout
  const organizeGoals = (goalsToOrganize: GoalCard[], missionCard: MissionCard): GoalCard[] => {
    const cardWidth = 320;
    const cardHeight = 140;
    const horizontalGap = 40;
    const verticalGap = 100;

    // Find root goals (goals without a parentId, or whose parent doesn't exist)
    const goalIds = new Set(goalsToOrganize.map(g => g.id));
    const rootGoals = goalsToOrganize.filter(g =>
      !g.parentId || !goalIds.has(g.parentId)
    );

    // Helper to get all descendants and calculate subtree width
    const getSubtreeWidth = (goalId: string): number => {
      const children = goalsToOrganize.filter(g => g.parentId === goalId);
      if (children.length === 0) {
        return cardWidth;
      }
      const childrenWidth = children.reduce((sum, child) => sum + getSubtreeWidth(child.id), 0);
      const gapsWidth = (children.length - 1) * horizontalGap;
      return Math.max(cardWidth, childrenWidth + gapsWidth);
    };

    // Calculate positions recursively
    const positionGoal = (goal: GoalCard, centerX: number, y: number): GoalCard[] => {
      const positioned: GoalCard[] = [];

      // Position this goal
      const positionedGoal = {
        ...goal,
        x: centerX - cardWidth / 2,
        y: y,
        width: cardWidth,
        height: cardHeight
      };
      positioned.push(positionedGoal);

      // Get and position children
      const children = goalsToOrganize.filter(g => g.parentId === goal.id);
      if (children.length > 0) {
        // Calculate total width needed for children
        const childrenWidths = children.map(c => getSubtreeWidth(c.id));
        const totalChildrenWidth = childrenWidths.reduce((sum, w) => sum + w, 0) + (children.length - 1) * horizontalGap;

        // Start position for first child (centered under parent)
        let currentX = centerX - totalChildrenWidth / 2;

        children.forEach((child, index) => {
          const childSubtreeWidth = childrenWidths[index];
          const childCenterX = currentX + childSubtreeWidth / 2;

          positioned.push(...positionGoal(child, childCenterX, y + cardHeight + verticalGap));

          currentX += childSubtreeWidth + horizontalGap;
        });
      }

      return positioned;
    };

    // Position all root goals
    const rootWidths = rootGoals.map(g => getSubtreeWidth(g.id));
    const totalRootWidth = rootWidths.reduce((sum, w) => sum + w, 0) + (rootGoals.length - 1) * horizontalGap;

    // Center under mission
    const missionCenterX = missionCard.x + missionCard.width / 2;
    let currentX = missionCenterX - totalRootWidth / 2;

    const allPositioned: GoalCard[] = [];

    rootGoals.forEach((rootGoal, index) => {
      const rootSubtreeWidth = rootWidths[index];
      const rootCenterX = currentX + rootSubtreeWidth / 2;

      allPositioned.push(...positionGoal(rootGoal, rootCenterX, missionCard.y + missionCard.height + verticalGap));

      currentX += rootSubtreeWidth + horizontalGap;
    });

    return allPositioned;
  };

  // Organize goals on initial load
  useEffect(() => {
    if (isInitialLoad && goals.length > 0) {
      // Check if goals need positioning (have invalid x/y)
      const needsOrganizing = goals.some(g =>
        typeof g.x !== 'number' || typeof g.y !== 'number' ||
        isNaN(g.x) || isNaN(g.y) || !isFinite(g.x) || !isFinite(g.y)
      );

      if (needsOrganizing) {
        const organizedGoals = organizeGoals(goals, mission);
        // Only update if we got valid results
        if (organizedGoals.length > 0) {
          setGoals(organizedGoals);
        }
      }

      setIsInitialLoad(false);
    }
  }, [isInitialLoad, goals.length]);

  // Save function
  const saveGoals = async () => {
    setIsSaving(true);
    try {
      // Convert goals back to GoalCardType for saving (dates as strings)
      const goalsToSave: GoalsData = {
        mission: mission,
        goals: goals.map(goal => ({
          ...goal,
          dueDate: goal.dueDate instanceof Date ? goal.dueDate.toISOString() : goal.dueDate
        })) as unknown as GoalCardType[]
      };

      const client = await getClient();
      // `PUT /weldflow/:projectId/goals` never existed (api-worker mounts no weldflow
      // routes). The canonical upsert is `PUT /api/goals/by-project/:projectId`, which
      // takes the same `{ mission, goals }` body and answers `{ data: { id } }`.
      // The client throws on a non-2xx, so a resolved promise means the save landed.
      await client.put<{ data: { id: string } }>(
        `/goals/by-project/${projectId}`,
        goalsToSave
      );
      // Silent success - no toast for auto-saves
    } catch (error) {
      console.error('Failed to save goals:', error);
      toast.error(st('sweep.weldflow.goalsCanvas.saveFailed'));
    } finally {
      setIsSaving(false);
    }
  };

  // Auto-save when goals or mission change (debounced)
  useEffect(() => {
    // Skip auto-save on initial load
    if (isInitialLoad) return;

    const timeoutId = setTimeout(() => {
      saveGoals();
    }, 1500); // Save 1.5 seconds after last change

    return () => clearTimeout(timeoutId);
  }, [goals, mission, isInitialLoad]);

  // Handle comments section resize
  const isResizingRef = useRef(false);
  const commentsHeightRef = useRef(commentsHeight);

  // Keep ref in sync with state
  useEffect(() => {
    commentsHeightRef.current = commentsHeight;
  }, [commentsHeight]);

  const handleCommentsResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const startY = e.clientY;
    const startHeight = commentsHeightRef.current;
    isResizingRef.current = true;

    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';

    const handleMouseMove = (moveEvent: MouseEvent) => {
      moveEvent.preventDefault();
      moveEvent.stopPropagation();
      const deltaY = startY - moveEvent.clientY;
      const newHeight = Math.min(Math.max(startHeight + deltaY, 100), 800);
      setCommentsHeight(newHeight);
    };

    const handleMouseUp = (upEvent: MouseEvent) => {
      upEvent.preventDefault();
      upEvent.stopPropagation();
      isResizingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', handleMouseMove, true);
      document.removeEventListener('mouseup', handleMouseUp, true);
    };

    document.addEventListener('mousemove', handleMouseMove, true);
    document.addEventListener('mouseup', handleMouseUp, true);
  };

  // Center the canvas view on the content
  const centerCanvasView = () => {
    if (!canvasRef.current) return;

    const rect = canvasRef.current.getBoundingClientRect();
    const viewportCenterX = rect.width / 2;
    const viewportCenterY = rect.height / 2;

    // Calculate bounding box of all cards (mission + goals) with safe defaults
    const allCards = [
      {
        x: mission.x ?? 600,
        y: mission.y ?? 50,
        width: mission.width ?? 320,
        height: mission.height ?? 160
      },
      ...goals.map(g => ({
        x: g.x ?? 0,
        y: g.y ?? 0,
        width: g.width ?? 320,
        height: g.height ?? 200
      }))
    ].filter(c =>
      // Filter out cards with invalid positions
      typeof c.x === 'number' && !isNaN(c.x) && isFinite(c.x) &&
      typeof c.y === 'number' && !isNaN(c.y) && isFinite(c.y)
    );

    // If no valid cards, just center on mission default position
    if (allCards.length === 0) {
      const missionCenterX = 600 + 160; // default mission x + width/2
      const missionCenterY = 50 + 80; // default mission y + height/2
      setPanPosition({
        x: viewportCenterX - missionCenterX,
        y: viewportCenterY - missionCenterY
      });
      return;
    }

    const minX = Math.min(...allCards.map(c => c.x));
    const maxX = Math.max(...allCards.map(c => c.x + c.width));
    const minY = Math.min(...allCards.map(c => c.y));
    const maxY = Math.max(...allCards.map(c => c.y + c.height));

    // Calculate center of all cards
    const contentCenterX = (minX + maxX) / 2;
    const contentCenterY = (minY + maxY) / 2;

    // Calculate pan position to center content in viewport
    const newX = viewportCenterX - contentCenterX;
    const newY = viewportCenterY - contentCenterY;

    if (isFinite(newX) && isFinite(newY)) {
      setPanPosition({ x: newX, y: newY });
    }
  };

  // Center view on initial load and when goals data changes
  useEffect(() => {
    if (isInitialLoad && canvasRef.current) {
      // Small delay to ensure DOM is ready
      const timer = setTimeout(() => {
        centerCanvasView();
        setIsInitialLoad(false);
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [isInitialLoad, mission, goals.length]);

  // Convert screen coordinates to canvas coordinates
  const screenToCanvas = (screenX: number, screenY: number) => {
    if (!canvasRef.current) return { x: 0, y: 0 };
    const rect = canvasRef.current.getBoundingClientRect();
    return {
      x: (screenX - rect.left - panPosition.x) / zoom,
      y: (screenY - rect.top - panPosition.y) / zoom
    };
  };

  // Get status color
  const getStatusColor = (status: GoalCard['status']) => {
    switch (status) {
      case 'on-track': return '#00bf63';
      case 'at-risk': return '#fcb400';
      case 'off-track': return '#f06a6a';
      case 'completed': return '#6a7985';
      case 'not-started': return '#9ca6af';
      default: return '#e8ecee';
    }
  };

  // Get status icon
  const getStatusIcon = (status: GoalCard['status']) => {
    switch (status) {
      case 'on-track': return <CheckCircle2 className="h-3.5 w-3.5" />;
      case 'at-risk': return <AlertCircle className="h-3.5 w-3.5" />;
      case 'off-track': return <XCircle className="h-3.5 w-3.5" />;
      case 'completed': return <CheckCircle2 className="h-3.5 w-3.5" />;
      case 'not-started': return <Clock className="h-3.5 w-3.5" />;
      default: return <Target className="h-3.5 w-3.5" />;
    }
  };

  // Get priority color
  const getPriorityColor = (priority?: GoalCard['priority']) => {
    switch (priority) {
      case 'critical': return '#dc2626';
      case 'high': return '#ea580c';
      case 'medium': return '#ca8a04';
      case 'low': return '#16a34a';
      default: return '#6b7280';
    }
  };

  // Toggle collapse/expand for a goal's children
  const toggleGoalCollapse = (goalId: string) => {
    setCollapsedGoals(prev => {
      const newSet = new Set(prev);
      if (newSet.has(goalId)) {
        newSet.delete(goalId);
      } else {
        newSet.add(goalId);
      }
      return newSet;
    });
  };

  // Handle sending a comment
  const handleSendComment = () => {
    if (!commentInput.trim() || !selectedGoal) return;

    const newComment: GoalComment = {
      id: `comment-${Date.now()}`,
      author: {
        name: 'Weld',
        initials: 'W',
      },
      content: commentInput,
      createdAt: new Date(),
      goalId: selectedGoal,
    };

    setComments(prev => [...prev, newComment]);
    setCommentInput('');
  };

  // Get comments for the selected goal
  const getGoalComments = (goalId: string) => {
    return comments.filter(comment => comment.goalId === goalId);
  };

  // Delete a goal and all its children
  const deleteGoal = (goalId: string) => {
    // Find all descendant goals (children, grandchildren, etc.)
    const getAllDescendants = (id: string): string[] => {
      const children = goals.filter(g => g.parentId === id);
      const descendants: string[] = [];
      children.forEach(child => {
        descendants.push(child.id);
        descendants.push(...getAllDescendants(child.id));
      });
      return descendants;
    };

    const descendantIds = getAllDescendants(goalId);
    const idsToDelete = new Set([goalId, ...descendantIds]);

    // Find the goal to get its parent
    const goalToDelete = goals.find(g => g.id === goalId);

    // Remove from mission's subGoals if it's a root goal
    if (!goalToDelete?.parentId || mission.subGoals?.includes(goalId)) {
      setMission(prev => ({
        ...prev,
        subGoals: (prev.subGoals || []).filter(id => id !== goalId)
      }));
    }

    // Remove from parent's subGoals if it has a parent goal
    if (goalToDelete?.parentId) {
      setGoals(prev => prev.map(g => {
        if (g.id === goalToDelete.parentId && g.subGoals) {
          return {
            ...g,
            subGoals: g.subGoals.filter(id => id !== goalId)
          };
        }
        return g;
      }).filter(g => !idsToDelete.has(g.id)));
    } else {
      setGoals(prev => prev.filter(g => !idsToDelete.has(g.id)));
    }

    // Close detail panel if the deleted goal was selected
    if (selectedGoal && idsToDelete.has(selectedGoal)) {
      setSelectedGoal(null);
      setShowDetailsPanel(false);
    }

    toast.success(st('sweep.weldflow.goalsCanvas.goalDeleted'));
  };

  // Calculate progress for a goal based on its children's progress (recursive average)
  const calculateGoalProgress = (goalId: string, goalsArray: GoalCard[]): number => {
    const children = goalsArray.filter(g => g.parentId === goalId);
    if (children.length === 0) {
      // Leaf node - return its own progress
      const goal = goalsArray.find(g => g.id === goalId);
      return goal?.progress || 0;
    }
    // Average the progress of all children
    const totalChildProgress = children.reduce((sum, child) => sum + child.progress, 0);
    return Math.round(totalChildProgress / children.length);
  };

  // Update all ancestor goals' progress when a goal status changes
  const updateAncestorProgress = (goalId: string, goalsArray: GoalCard[]): GoalCard[] => {
    let updatedGoals = [...goalsArray];
    let currentGoal = updatedGoals.find(g => g.id === goalId);

    // Traverse up the tree and update each parent's progress
    while (currentGoal?.parentId) {
      const parentId = currentGoal.parentId;
      const parentProgress = calculateGoalProgress(parentId, updatedGoals);

      updatedGoals = updatedGoals.map(g => {
        if (g.id === parentId) {
          const allChildrenCompleted = parentProgress === 100;
          const anyChildStarted = parentProgress > 0;
          let newStatus = g.status;

          if (allChildrenCompleted) {
            newStatus = 'completed';
          } else if (anyChildStarted && g.status === 'completed') {
            newStatus = 'on-track';
          } else if (anyChildStarted && g.status === 'not-started') {
            newStatus = 'on-track';
          } else if (parentProgress === 0 && g.status !== 'not-started') {
            newStatus = 'not-started';
          }

          return {
            ...g,
            progress: parentProgress,
            status: newStatus
          };
        }
        return g;
      });

      currentGoal = updatedGoals.find(g => g.id === parentId);
    }

    return updatedGoals;
  };

  // Toggle goal completion and update parent progress
  const toggleGoalComplete = (goalId: string) => {
    setGoals(prev => {
      // First, update the goal's own status
      let updatedGoals = prev.map(g => {
        if (g.id === goalId) {
          return {
            ...g,
            status: g.status === 'completed' ? 'not-started' : 'completed',
            progress: g.status === 'completed' ? 0 : 100
          } as GoalCard;
        }
        return g;
      });

      // Then update all ancestor goals' progress
      updatedGoals = updateAncestorProgress(goalId, updatedGoals);

      return updatedGoals;
    });
  };

  // Add a root-level goal (child of mission)
  const addRootGoal = (title: string, target: string, linkedTaskId?: string) => {
    const newGoalId = `goal-${Date.now()}`;

    // Find existing root goals (goals linked to mission)
    const existingRootGoals = goals.filter(g =>
      !g.parentId || mission.subGoals?.includes(g.id)
    );

    const cardWidth = 320;
    const cardHeight = 140;
    const horizontalSpacing = 100;
    const verticalGap = 100;

    // Calculate position - place to the right of existing root goals
    const missionCenterX = mission.x + mission.width / 2;
    const missionBottomY = mission.y + mission.height;

    const totalRootGoals = existingRootGoals.length + 1;
    const totalWidth = (totalRootGoals * cardWidth) + ((totalRootGoals - 1) * horizontalSpacing);
    const startX = missionCenterX - (totalWidth / 2);

    const newGoal: GoalCard = {
      id: newGoalId,
      title: title || 'New goal',
      description: 'Goal',
      owner: {
        name: 'Weld',
        initials: 'W',
        color: '#8b5cf6'
      },
      status: 'not-started',
      progress: 0,
      dueDate: new Date(),
      timePeriod: 'Q4 FY25',
      type: 'company',
      x: startX + (existingRootGoals.length * (cardWidth + horizontalSpacing)),
      y: missionBottomY + verticalGap,
      width: cardWidth,
      height: cardHeight,
      metrics: {
        target: target ? parseInt(target) : 0,
        current: 0,
        unit: 'subgoals'
      },
      updates: 0,
      priority: 'medium',
      ...(linkedTaskId ? { linkedTaskId } : {}),
    };

    // Update mission's subGoals and reposition existing root goals
    setMission(prev => ({
      ...prev,
      subGoals: [...(prev.subGoals || []), newGoalId]
    }));

    // Reposition existing root goals to center them with the new one
    setGoals(prev => {
      const repositioned = prev.map(g => {
        if (!g.parentId || mission.subGoals?.includes(g.id)) {
          const index = existingRootGoals.findIndex(rg => rg.id === g.id);
          if (index !== -1) {
            return {
              ...g,
              x: startX + (index * (cardWidth + horizontalSpacing))
            };
          }
        }
        return g;
      });
      return [...repositioned, newGoal];
    });
  };

  // Add a child goal to a parent goal
  const addChildGoal = (parentId: string, title: string, target: string, linkedTaskId?: string) => {
    const parent = goals.find(g => g.id === parentId);
    if (!parent) return;

    // Create new child goal
    const newGoalId = `goal-${Date.now()}`;
    const existingChildren = goals.filter(g => g.parentId === parentId);
    const totalChildren = existingChildren.length + 1; // Include the new child

    // Calculate position for all children (centered under parent)
    const parentX = parent.x + parent.width / 2;
    const parentY = parent.y + parent.height;

    const childWidth = 320;
    const horizontalSpacing = 100;
    const verticalGap = 80;
    const minChildSpacing = 100; // Minimum spacing between children of different parents

    // Calculate total width of all children (including the new one)
    const totalWidth = (totalChildren * childWidth) + ((totalChildren - 1) * horizontalSpacing);
    const startX = parentX - (totalWidth / 2);

    // Calculate old width (before adding new child)
    const oldWidth = existingChildren.length > 0
      ? (existingChildren.length * childWidth) + ((existingChildren.length - 1) * horizontalSpacing)
      : 0;
    const oldStartX = parentX - (oldWidth / 2);

    // Get all sibling parents (goals with the same parent - could be mission's children or same level)
    const siblingParents = goals.filter(g =>
      g.parentId === parent.parentId &&
      g.id !== parentId
    );

    const newGoal: GoalCard = {
      id: newGoalId,
      title: title || 'New goal',
      description: 'Goal',
      owner: {
        name: 'Weld',
        initials: 'W',
        color: '#8b5cf6'
      },
      status: 'not-started',
      progress: 0,
      dueDate: new Date(),
      timePeriod: 'Q4 FY25',
      type: 'team',
      x: startX + (existingChildren.length * (childWidth + horizontalSpacing)),
      y: parentY + verticalGap,
      width: 320,
      height: 140,
      parentId: parentId,
      linkedTaskId,
      metrics: {
        target: target ? parseInt(target) : 0,
        current: 0,
        unit: 'subgoals'
      },
      updates: 0,
      priority: 'medium'
    };

    // Calculate the rightmost edge of this parent's children
    const parentLeftEdge = startX;
    const parentRightEdge = startX + totalWidth;

    // Update parent's subGoals array and reposition all existing children
    setGoals(prev => {
      // First pass: calculate which siblings need to move and by how much
      const adjustments = new Map<string, number>();

      siblingParents.forEach(sibling => {
        // Only check siblings that are to the right of the current parent
        if (sibling.x <= parent.x) return;

        // Calculate sibling's children bounds
        const siblingChildren = prev.filter(g => g.parentId === sibling.id);
        const siblingChildCount = siblingChildren.length;

        if (siblingChildCount > 0) {
          // Sibling has children - calculate their actual leftmost position
          const siblingChildWidth = (siblingChildCount * childWidth) + ((siblingChildCount - 1) * horizontalSpacing);
          const siblingX = sibling.x + sibling.width / 2;
          const siblingChildStartX = siblingX - (siblingChildWidth / 2);

          // Check if the NEW child (not existing ones) would cause overlap
          // Only consider this an overlap if the rightmost edge is extending into the sibling's space
          const actualGap = siblingChildStartX - parentRightEdge;

          // Only move if adding this new child causes the gap to be insufficient
          if (actualGap < minChildSpacing) {
            const neededOffset = minChildSpacing - actualGap;
            adjustments.set(sibling.id, neededOffset);
          }
        } else {
          // Sibling has no children yet - only check if we're really extending into their potential space
          const siblingX = sibling.x + sibling.width / 2;
          const potentialChildStartX = siblingX - (childWidth / 2);

          // Check if our children are extending too far right
          const actualGap = potentialChildStartX - parentRightEdge;

          // Only move if the gap is insufficient
          if (actualGap < minChildSpacing) {
            const neededOffset = minChildSpacing - actualGap;
            adjustments.set(sibling.id, neededOffset);
          }
        }
      });

      // Second pass: apply adjustments
      const updated = prev.map(g => {
        // Update parent
        if (g.id === parentId) {
          return {
            ...g,
            subGoals: [...(g.subGoals || []), newGoalId],
            metrics: {
              ...g.metrics,
              target: totalChildren,
              current: g.metrics?.current || 0,
              unit: 'subgoals'
            }
          };
        }

        // Reposition existing children of current parent to center them
        if (g.parentId === parentId) {
          const childIndex = existingChildren.findIndex(c => c.id === g.id);
          return {
            ...g,
            x: startX + (childIndex * (childWidth + horizontalSpacing)),
            y: parentY + verticalGap
          };
        }

        // Move sibling parents that need adjustment
        const offset = adjustments.get(g.id);
        if (offset) {
          return {
            ...g,
            x: g.x + offset
          };
        }

        // Move children of adjusted parents
        const parentOffset = g.parentId ? adjustments.get(g.parentId) : undefined;
        if (parentOffset) {
          return {
            ...g,
            x: g.x + parentOffset
          };
        }

        return g;
      });
      return [...updated, newGoal];
    });

    // Expand parent if it was collapsed
    if (collapsedGoals.has(parentId)) {
      toggleGoalCollapse(parentId);
    }

    // Reset form and close modal
    setNewGoalTitle('');
    setNewGoalTarget('');
    setShowAddChildModal(false);
    setParentGoalForNewChild(null);
  };

  // Handle mouse down
  const handleMouseDown = (e: React.MouseEvent, goalId?: string) => {

    if (tool === 'select' && goalId) {
      // Start dragging a goal in select mode
      const goal = goals.find(g => g.id === goalId);
      if (goal) {
        e.preventDefault();
        setIsDragging(true);
        setDraggedGoal(goalId);
        // Store the initial mouse position and goal position
        dragStartMouse.current = { x: e.clientX, y: e.clientY };
        dragStartGoal.current = { x: goal.x, y: goal.y };
        // Initialize current position to goal's current position (in case of click without drag)
        dragCurrentPosition.current = { x: goal.x, y: goal.y };
        hasDraggedRef.current = false;
      }
    } else if (tool === 'pan' || (tool === 'select' && e.shiftKey)) {
      // Start panning with pan tool or shift key
      setIsPanning(true);
      setPanStart({
        x: e.clientX - panPosition.x,
        y: e.clientY - panPosition.y
      });
    } else if (!goalId) {
      // Clicked on empty canvas area - start panning
      setIsPanning(true);
      setPanStart({
        x: e.clientX - panPosition.x,
        y: e.clientY - panPosition.y
      });
      // Don't deselect goal or close panel when panning
    }
  };

  // Handle mouse move
  const handleMouseMove = (e: React.MouseEvent) => {
    if (isPanning) {
      // Update ref immediately for smooth visual feedback
      panPositionRef.current = {
        x: e.clientX - panStart.x,
        y: e.clientY - panStart.y
      };

      // Update DOM directly for smooth animation
      const canvasContent = canvasRef.current?.firstElementChild as HTMLElement;
      if (canvasContent) {
        canvasContent.style.transform = `translate(${panPositionRef.current.x}px, ${panPositionRef.current.y}px) scale(${zoom})`;
      }
    } else if (isDragging && draggedGoal && draggedElementRef.current) {
      // Calculate the mouse movement delta
      const deltaX = (e.clientX - dragStartMouse.current.x) / zoom;
      const deltaY = (e.clientY - dragStartMouse.current.y) / zoom;

      // If the mouse moved more than 3 pixels, consider it a drag
      if (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3) {
        hasDraggedRef.current = true;
      }

      // Update position using ref (no state update, no re-render)
      let newX = dragStartGoal.current.x + deltaX;
      const newY = dragStartGoal.current.y + deltaY;

      // Snap alignment detection
      const draggedGoalData = goals.find(g => g.id === draggedGoal);
      if (draggedGoalData) {
        const draggedWidth = draggedGoalData.width ?? 320;
        const draggedHeight = draggedGoalData.height ?? 200;
        const draggedCenterX = newX + draggedWidth / 2;
        const draggedLeftX = newX;
        const draggedRightX = newX + draggedWidth;
        const draggedTop = newY;
        const draggedBottom = newY + draggedHeight;

        const guides: AlignmentGuide[] = [];
        let snapX: number | null = null;

        // All other cards to check alignment against (goals + mission)
        const otherCards = [
          ...goals.filter(g => g.id !== draggedGoal).map(g => ({
            x: g.x, y: g.y, width: g.width ?? 320, height: g.height ?? 200
          })),
          { x: mission.x, y: mission.y, width: mission.width, height: mission.height }
        ];

        for (const card of otherCards) {
          const cardCenterX = card.x + card.width / 2;
          const cardLeftX = card.x;
          const cardRightX = card.x + card.width;
          const cardTop = card.y;
          const cardBottom = card.y + card.height;

          const yStart = Math.min(draggedTop, cardTop) + 20;
          const yEnd = Math.max(draggedBottom, cardBottom) - 20;

          // Check center alignment (snap without guide line)
          if (Math.abs(draggedCenterX - cardCenterX) < ALIGNMENT_THRESHOLD) {
            if (snapX === null) {
              snapX = cardCenterX - draggedWidth / 2;
            }
          }

          // Check left edge alignment
          if (Math.abs(draggedLeftX - cardLeftX) < ALIGNMENT_THRESHOLD) {
            guides.push({ x: cardLeftX, type: 'left', yStart, yEnd });
            if (snapX === null) {
              snapX = cardLeftX;
            }
          }

          // Check right edge alignment
          if (Math.abs(draggedRightX - cardRightX) < ALIGNMENT_THRESHOLD) {
            guides.push({ x: cardRightX, type: 'right', yStart, yEnd });
            if (snapX === null) {
              snapX = cardRightX - draggedWidth;
            }
          }
        }

        if (snapX !== null) {
          newX = snapX;
        }

        // Update guides (batched with the render trigger below)
        if (rafRef.current === null) {
          setAlignmentGuides(guides);
        }
      }

      dragCurrentPosition.current = { x: newX, y: newY };

      // Calculate snapped delta for DOM transform
      const snappedDeltaX = newX - dragStartGoal.current.x;

      // Directly update the DOM element for smooth dragging
      draggedElementRef.current.style.transform = `translate(${snappedDeltaX}px, ${deltaY}px)`;

      // Throttle re-renders for connection lines using requestAnimationFrame
      if (rafRef.current === null) {
        rafRef.current = requestAnimationFrame(() => {
          setDragRenderTrigger(prev => prev + 1);
          rafRef.current = null;
        });
      }
    }
  };

  // Handle mouse up
  const handleMouseUp = () => {
    // If we were dragging and actually moved, update the final position
    if (isDragging && draggedGoal && draggedElementRef.current) {
      // Reset transform
      draggedElementRef.current.style.transform = '';

      // Only update position if there was actual dragging movement
      if (hasDraggedRef.current) {
        setGoals(prev => prev.map(goal =>
          goal.id === draggedGoal
            ? {
                ...goal,
                x: dragCurrentPosition.current.x,
                y: dragCurrentPosition.current.y
              }
            : goal
        ));
      }
    }

    // Clear alignment guides
    setAlignmentGuides([]);

    // Sync pan position state when panning ends
    if (isPanning) {
      setPanPosition({ ...panPositionRef.current });
    }

    setIsPanning(false);
    setIsDragging(false);
    setDraggedGoal(null);
    draggedElementRef.current = null;
  };

  // Keep panPositionRef in sync with state
  useEffect(() => {
    panPositionRef.current = panPosition;
  }, [panPosition]);

  // Handle touch start for mobile panning
  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 1) {
      const touch = e.touches[0];
      lastTouchRef.current = { x: touch.clientX, y: touch.clientY };
      setIsPanning(true);
    }
  };

  // Handle touch move for mobile panning
  const handleTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length === 1 && lastTouchRef.current) {
      e.preventDefault();
      const touch = e.touches[0];
      const deltaX = touch.clientX - lastTouchRef.current.x;
      const deltaY = touch.clientY - lastTouchRef.current.y;

      // Update ref immediately for smooth visual feedback
      panPositionRef.current = {
        x: panPositionRef.current.x + deltaX,
        y: panPositionRef.current.y + deltaY
      };

      // Update DOM directly for smooth animation
      const canvasContent = canvasRef.current?.firstElementChild as HTMLElement;
      if (canvasContent) {
        canvasContent.style.transform = `translate(${panPositionRef.current.x}px, ${panPositionRef.current.y}px) scale(${zoom})`;
      }

      lastTouchRef.current = { x: touch.clientX, y: touch.clientY };
    }
  };

  // Handle touch end
  const handleTouchEnd = () => {
    // Sync state with final position
    if (lastTouchRef.current) {
      setPanPosition({ ...panPositionRef.current });
    }
    lastTouchRef.current = null;
    setIsPanning(false);
  };

  // Handle wheel for zoom and scroll
  const handleWheel = (e: React.WheelEvent) => {
    // Zoom with Ctrl/Cmd + wheel
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      
      // Smooth zoom using continuous scale instead of discrete levels
      const zoomSpeed = 0.002;
      const delta = -e.deltaY * zoomSpeed;
      
      // Calculate new scale with smooth interpolation
      const newScale = Math.min(Math.max(0.025, zoom * (1 + delta)), 5);
      const scaleRatio = newScale / zoom;
      
      // Get the center of the viewport
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const centerX = rect.width / 2;
      const centerY = rect.height / 2;
      
      // Adjust pan position so zoom is centered at viewport center
      setPanPosition(prev => ({
        x: centerX - (centerX - prev.x) * scaleRatio,
        y: centerY - (centerY - prev.y) * scaleRatio
      }));
      
      // Update zoom index to nearest level for UI display
      const nearestIndex = zoomLevels.reduce((prev, curr, index) => {
        return Math.abs(curr - newScale) < Math.abs(zoomLevels[prev] - newScale) ? index : prev;
      }, 0);
      
      setZoomIndex(nearestIndex);
      setZoom(newScale);
      setIsZooming(true);
      setTimeout(() => setIsZooming(false), 250);
    } else {
      // Regular scrolling when Ctrl/Cmd is not pressed
      e.preventDefault();
      const scrollSpeed = 1.5;
      setPanPosition(prev => ({
        x: prev.x - e.deltaX * scrollSpeed,
        y: prev.y - e.deltaY * scrollSpeed
      }));
    }
  };

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore keyboard shortcuts when typing in an input or textarea
      const target = e.target as HTMLElement;
      const isTyping = target.tagName === 'INPUT' ||
                       target.tagName === 'TEXTAREA' ||
                       target.isContentEditable;

      // ESC to deselect (works even when typing to close modals)
      if (e.key === 'Escape') {
        setSelectedGoal(null);
      }

      // Skip other shortcuts when typing
      if (isTyping) return;

      // Space bar for temporary pan tool (hold)
      if (e.key === ' ' && !e.repeat) {
        e.preventDefault();
        setTool('pan');
      }
      
      // Zoom shortcuts - snap to discrete zoom levels
      if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        
        // Use the tracked index directly
        if (zoomIndex < zoomLevels.length - 1) {
          const newIndex = zoomIndex + 1;
          const newScale = zoomLevels[newIndex];
          const scaleRatio = newScale / zoom;
          
          // Get viewport center
          const rect = canvasRef.current?.getBoundingClientRect();
          if (rect) {
            const centerX = rect.width / 2;
            const centerY = rect.height / 2;
            
            // Adjust pan to zoom towards viewport center
            setPanPosition(prev => ({
              x: centerX - (centerX - prev.x) * scaleRatio,
              y: centerY - (centerY - prev.y) * scaleRatio
            }));
          }
          
          setZoomIndex(newIndex);
          setZoom(newScale);
          setIsZooming(true);
          setTimeout(() => setIsZooming(false), 250);
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key === '-') {
        e.preventDefault();
        
        // Use the tracked index directly
        if (zoomIndex > 0) {
          const newIndex = zoomIndex - 1;
          const newScale = zoomLevels[newIndex];
          const scaleRatio = newScale / zoom;
          
          // Get viewport center
          const rect = canvasRef.current?.getBoundingClientRect();
          if (rect) {
            const centerX = rect.width / 2;
            const centerY = rect.height / 2;
            
            // Adjust pan to zoom towards viewport center
            setPanPosition(prev => ({
              x: centerX - (centerX - prev.x) * scaleRatio,
              y: centerY - (centerY - prev.y) * scaleRatio
            }));
          }
          
          setZoomIndex(newIndex);
          setZoom(newScale);
          setIsZooming(true);
          setTimeout(() => setIsZooming(false), 250);
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key === '0') {
        e.preventDefault();
        setZoom(1);
        setZoomIndex(8); // Index 8 = 100%
        setPanPosition({ x: 0, y: 0 });
        setIsZooming(true);
        setTimeout(() => setIsZooming(false), 250);
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      // Ignore when typing in an input or textarea
      const target = e.target as HTMLElement;
      const isTyping = target.tagName === 'INPUT' ||
                       target.tagName === 'TEXTAREA' ||
                       target.isContentEditable;
      if (isTyping) return;

      // Release space bar to go back to select tool
      if (e.key === ' ') {
        setTool('select');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [zoom, zoomIndex, zoomLevels, canvasRef]);

  // Render mission card
  const renderMissionCard = (missionData: MissionCard) => {
    return (
      <div
        key={missionData.id}
        className="absolute bg-white dark:bg-background rounded-lg border border-gray-200 dark:border-border group/mission after:content-[''] after:absolute after:top-full after:left-0 after:right-0 after:h-12"
        style={{
          left: `${missionData.x}px`,
          top: `${missionData.y}px`,
          width: `${missionData.width}px`,
          height: `${missionData.height}px`,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          pointerEvents: 'auto'
        }}
        onMouseEnter={() => setHoveredGoal(missionData.id)}
        onMouseLeave={() => setHoveredGoal(null)}
      >
        <div className="text-center px-4">
          {canWrite ? (
            <>
              <input
                type="text"
                value={missionData.description}
                onChange={(e) => setMission(prev => ({ ...prev, description: e.target.value }))}
                className="text-xs text-gray-500 dark:text-muted-foreground mb-2 bg-transparent border-none text-center w-full focus:outline-none focus:ring-1 focus:ring-gray-300 rounded px-1"
                placeholder={st('sweep.weldflow.goalsCanvas.missionDescriptionPlaceholder')}
              />
              <input
                type="text"
                value={missionData.title}
                onChange={(e) => setMission(prev => ({ ...prev, title: e.target.value }))}
                className="text-lg font-semibold text-gray-900 dark:text-foreground bg-transparent border-none text-center w-full focus:outline-none focus:ring-1 focus:ring-gray-300 rounded px-1"
                placeholder={st('sweep.weldflow.goalsCanvas.missionTitlePlaceholder')}
              />
            </>
          ) : (
            <>
              <p className="text-xs text-gray-500 dark:text-muted-foreground mb-2">{missionData.description}</p>
              <h2 className="text-lg font-semibold text-gray-900 dark:text-foreground">{missionData.title}</h2>
            </>
          )}
        </div>
      </div>
    );
  };

  // Render goal card - simplified version matching screenshot
  const renderGoalCard = (goal: GoalCard) => {
    const isHighlighted = highlightStatus !== 'none' && goal.status === highlightStatus;
    const statusColor = getStatusColor(goal.status);
    const isDraggingThis = isDragging && draggedGoal === goal.id;

    return (
      <div
        key={goal.id}
        ref={(el) => {
          if (isDraggingThis && el) {
            draggedElementRef.current = el;
          }
        }}
        className={cn(
          "absolute bg-white dark:bg-background rounded-lg border",
          "after:content-[''] after:absolute after:top-full after:left-0 after:right-0 after:h-12",
          selectedGoal === goal.id ? "border-gray-400 dark:border-gray-500 ring-2 ring-gray-400/10 dark:ring-gray-500/10 z-20" : "border-gray-200 dark:border-border",
          isHighlighted && "ring-2 ring-yellow-400",
          isDraggingThis ? "opacity-90 z-30" : "",
          tool === 'select' ? "cursor-move" : "cursor-default"
        )}
        style={{
          left: `${goal.x}px`,
          top: `${goal.y}px`,
          width: `${goal.width}px`,
          height: `${goal.height}px`,
          display: 'flex',
          flexDirection: 'column',
          pointerEvents: isDragging && !isDraggingThis ? 'none' : 'auto',
          willChange: isDraggingThis ? 'transform' : 'auto'
        }}
        onClick={(e) => {
          e.stopPropagation();
          // Only open panel if user didn't drag
          if (!hasDraggedRef.current) {
            if (goal.linkedTaskId) {
              // Move the card selection indicator to the clicked goal, then
              // push the real task onto the global object-panel stack.
              setSelectedGoal(goal.id);
              setShowDetailsPanel(false);
              openObjectPanel({ type: 'task', id: goal.linkedTaskId });
            } else {
              // Goal mode — render the goal as a task in the legacy panel
              // (goals are not real tasks, so the unified TaskPanel can't
              // fetch them from app-api).
              setSelectedGoal(goal.id);
              setShowDetailsPanel(true);
            }
          }
        }}
        onMouseDown={(e) => {
          if (tool === 'select') {
            e.stopPropagation();
            e.preventDefault();
            handleMouseDown(e, goal.id);
          }
        }}
        onMouseEnter={() => setHoveredGoal(goal.id)}
        onMouseLeave={() => setHoveredGoal(null)}
      >
        {/* Card Header */}
        <div className="px-4 py-3 border-b border-gray-100 dark:border-border flex-shrink-0">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 flex-1 min-w-0">
              {/* Status Badge */}
              <TagLabel tag={goal.status.replace('-', ' ')} className="capitalize" />
            </div>

            <div className="flex items-center gap-1">
              {/* More Options Menu */}
              {canWrite && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      className={cn(
                        "h-6 w-6 rounded flex items-center justify-center hover:bg-gray-100 dark:hover:bg-secondary transition-all",
                        hoveredGoal === goal.id ? "opacity-100" : "opacity-0"
                      )}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <MoreHorizontal className="h-4 w-4 text-gray-500" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive"
                      onClick={(e) => {
                        e.stopPropagation();
                        setGoalToDelete(goal.id);
                        setShowDeleteConfirmModal(true);
                      }}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" style={{ marginRight: '2px' }} />
                      {st('sweep.weldflow.goalsCanvas.deleteGoal')}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}

            </div>
          </div>
        </div>

        {/* Card Content */}
        <div className="px-4 py-2.5 flex-1 flex flex-col justify-center">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-foreground mb-1 line-clamp-2">
            {goal.title}
          </h3>
          {goal.metrics && (
            <p className="text-xs text-gray-600 dark:text-muted-foreground mb-2">
              {goal.metrics.current} / {goal.metrics.target} {goal.metrics.unit}
            </p>
          )}
          {/* Progress Bar */}
          <div className="flex items-center gap-2">
            <div className="flex-1 h-1.5 bg-gray-200 dark:bg-accent rounded-full overflow-hidden">
              <div
                className={cn(
                  "h-full rounded-full transition-all",
                  goal.status === 'on-track' && "bg-green-500",
                  goal.status === 'at-risk' && "bg-yellow-500",
                  goal.status === 'off-track' && "bg-red-500",
                  goal.status === 'not-started' && "bg-gray-400",
                  goal.status === 'completed' && "bg-blue-500"
                )}
                style={{ width: `${goal.progress}%` }}
              />
            </div>
            <span className="text-[10px] font-medium text-gray-600 dark:text-muted-foreground tabular-nums">
              {goal.progress}%
            </span>
          </div>
        </div>
      </div>
    );
  };

  // Memoize parent goals to avoid recalculating on every render
  const parentGoals = useMemo(() => {
    return goals.filter(g => g.subGoals && g.subGoals.length > 0);
  }, [goals]);

  // Helper function to check if a position is valid
  const isValidPosition = (pos: { x: number; y: number }) => {
    return typeof pos.x === 'number' && typeof pos.y === 'number' &&
           !isNaN(pos.x) && !isNaN(pos.y) && isFinite(pos.x) && isFinite(pos.y);
  };

  // Helper function to get goal position (considering drag state)
  const getGoalPosition = (goal: GoalCard) => {
    if (isDragging && draggedGoal === goal.id) {
      return {
        x: dragCurrentPosition.current.x,
        y: dragCurrentPosition.current.y
      };
    }
    return { x: goal.x ?? 0, y: goal.y ?? 0 };
  };

  // Helper to get goal dimensions with defaults
  const getGoalDimensions = (goal: GoalCard) => ({
    width: goal.width ?? 320,
    height: goal.height ?? 140
  });

  // Render connections between goals and mission
  const renderConnections = () => {
    if (!showConnections) return null;

    return (
      <>
        <svg
          className="absolute pointer-events-none"
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: '10000px',
            height: '10000px'
          }}
        >
          {/* Connection from mission to root goals - smoothstep style */}
          {goals.filter(g => !g.parentId || !goals.some(p => p.id === g.parentId)).map(goal => {
            const goalPos = getGoalPosition(goal);
            if (!isValidPosition(goalPos)) return null;
            const goalDims = getGoalDimensions(goal);
            const startX = (mission.x ?? 600) + (mission.width ?? 320) / 2;
            const startY = (mission.y ?? 50) + (mission.height ?? 160);
            const endX = goalPos.x + goalDims.width / 2;
            const endY = goalPos.y;

            const midY = startY + (endY - startY) / 2;
            const horizontalDist = Math.abs(endX - startX);
            const verticalTop = midY - startY;
            const verticalBottom = endY - midY;
            const r = Math.min(8, horizontalDist / 2, verticalTop, verticalBottom);

            let d: string;
            if (startX === endX || horizontalDist < 1) {
              d = `M ${startX} ${startY} L ${startX} ${endY}`;
            } else {
              const dir = endX > startX ? 1 : -1;
              d = `M ${startX} ${startY} L ${startX} ${midY - r} Q ${startX} ${midY}, ${startX + dir * r} ${midY} L ${endX - dir * r} ${midY} Q ${endX} ${midY}, ${endX} ${midY + r} L ${endX} ${endY}`;
            }

            return (
              <path
                key={`mission-${goal.id}`}
                d={d}
                className="stroke-gray-300 dark:stroke-gray-600"
                strokeWidth="1.5"
                fill="none"
              />
            );
          })}

          {/* Line from parent goals to arrow buttons */}
          {parentGoals.map(parentGoal => {
              const parentPos = getGoalPosition(parentGoal);
              if (!isValidPosition(parentPos)) return null;
              const parentDims = getGoalDimensions(parentGoal);
              const parentX = parentPos.x + parentDims.width / 2;
              const parentY = parentPos.y + parentDims.height;
              const arrowButtonY = parentY + 20;

              return (
                <line
                  key={`parent-to-arrow-${parentGoal.id}`}
                  x1={parentX}
                  y1={parentY}
                  x2={parentX}
                  y2={arrowButtonY - 12}
                  className="stroke-gray-300 dark:stroke-gray-600"
                  strokeWidth="1.5"
                />
              );
            })}

          {/* Connections from arrow buttons to child goals - smoothstep style */}
          {parentGoals.map(parentGoal => {
              if (collapsedGoals.has(parentGoal.id)) return null;

              const children = goals.filter(g => parentGoal.subGoals?.includes(g.id));
              if (children.length === 0) return null;

              const parentPos = getGoalPosition(parentGoal);
              if (!isValidPosition(parentPos)) return null;
              const parentDims = getGoalDimensions(parentGoal);
              const parentX = parentPos.x + parentDims.width / 2;
              const parentY = parentPos.y + parentDims.height;
              const arrowButtonY = parentY + 20;

              return children.map(child => {
                const childPos = getGoalPosition(child);
                if (!isValidPosition(childPos)) return null;
                const childDims = getGoalDimensions(child);
                const childX = childPos.x + childDims.width / 2;
                const childY = childPos.y;

                const startY = arrowButtonY + 12;
                const midY = startY + (childY - startY) / 2;
                const horizontalDist = Math.abs(childX - parentX);
                const verticalTop = midY - startY;
                const verticalBottom = childY - midY;
                const r = Math.min(8, horizontalDist / 2, verticalTop, verticalBottom);

                let d: string;
                if (parentX === childX || horizontalDist < 1) {
                  d = `M ${parentX} ${startY} L ${parentX} ${childY}`;
                } else {
                  const dir = childX > parentX ? 1 : -1;
                  d = `M ${parentX} ${startY} L ${parentX} ${midY - r} Q ${parentX} ${midY}, ${parentX + dir * r} ${midY} L ${childX - dir * r} ${midY} Q ${childX} ${midY}, ${childX} ${midY + r} L ${childX} ${childY}`;
                }

                return (
                  <path
                    key={`${parentGoal.id}-${child.id}`}
                    d={d}
                    className="stroke-gray-300 dark:stroke-gray-600"
                    strokeWidth="1.5"
                    fill="none"
                  />
                );
              });
            })}
        </svg>

        {/* Arrow buttons at branch points for all parent goals */}
        {parentGoals.map(parentGoal => {
            const parentPos = getGoalPosition(parentGoal);
            if (!isValidPosition(parentPos)) return null;
            const parentDims = getGoalDimensions(parentGoal);
            const parentX = parentPos.x + parentDims.width / 2;
            const parentY = parentPos.y + parentDims.height;
            const isCollapsed = collapsedGoals.has(parentGoal.id);

            return (
              <div
                key={`arrow-${parentGoal.id}`}
                className="absolute pointer-events-auto"
                style={{
                  left: `${parentX}px`,
                  top: `${parentY + 20}px`,
                  transform: 'translate(-50%, -50%)'
                }}
              >
                <Button
                  variant="ghost"
                  className="w-6 h-5 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 flex items-center justify-center hover:bg-gray-50 dark:hover:bg-gray-700 transition-all"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleGoalCollapse(parentGoal.id);
                  }}
                >
                  <svg
                    className="w-3 h-3 text-gray-600 dark:text-gray-400 transition-transform"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    style={{
                      transform: isCollapsed ? 'rotate(180deg)' : 'rotate(0deg)'
                    }}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </Button>
              </div>
            );
          })}
      </>
    );
  };

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)]">
      {/* Top Bar */}
      <div className="flex items-center justify-between px-4 h-[53px] border-b border-border bg-background">
        <div className="flex items-center gap-2">
          <FilterPills
            filters={activeFilters}
            filterConfigs={filterConfigs}
            maxFilters={5}
            onFiltersChange={setActiveFilters}
          />

          {/* Highlight */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className={cn(
                "h-8 shadow-none text-sm text-muted-foreground",
                highlightStatus === 'on-track' && "bg-green-50 border-green-300 text-green-700 hover:bg-green-100 dark:bg-green-950 dark:border-green-700 dark:text-green-400 dark:hover:bg-green-900",
                highlightStatus === 'at-risk' && "bg-yellow-50 border-yellow-300 text-yellow-700 hover:bg-yellow-100 dark:bg-yellow-950 dark:border-yellow-700 dark:text-yellow-400 dark:hover:bg-yellow-900",
                highlightStatus === 'off-track' && "bg-red-50 border-red-300 text-red-700 hover:bg-red-100 dark:bg-red-950 dark:border-red-700 dark:text-red-400 dark:hover:bg-red-900",
                highlightStatus === 'not-started' && "bg-gray-100 border-gray-300 text-gray-700 hover:bg-gray-200 dark:bg-secondary dark:border-gray-600 dark:text-muted-foreground dark:hover:bg-accent",
                highlightStatus === 'completed' && "bg-blue-50 border-blue-300 text-blue-700 hover:bg-blue-100 dark:bg-blue-950 dark:border-blue-700 dark:text-blue-400 dark:hover:bg-blue-900",
              )}>
                {highlightStatus === 'none' ? st('sweep.weldflow.goalsCanvas.highlight') : {
                  'on-track': st('sweep.weldflow.goalsCanvas.onTrack'),
                  'at-risk': st('sweep.weldflow.goalsCanvas.atRisk'),
                  'off-track': st('sweep.weldflow.goalsCanvas.offTrack'),
                  'not-started': st('sweep.weldflow.goalsCanvas.notStarted'),
                  'completed': st('sweep.weldflow.goalsCanvas.completed'),
                }[highlightStatus]}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-48">
              <DropdownMenuItem onClick={() => setHighlightStatus('on-track')}>
                <div className="flex items-center gap-2">
                  <div className="w-2.5 h-2.5 rounded-[3px] bg-green-500" />
                  {st('sweep.weldflow.goalsCanvas.onTrack')}
                </div>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setHighlightStatus('at-risk')}>
                <div className="flex items-center gap-2">
                  <div className="w-2.5 h-2.5 rounded-[3px] bg-yellow-500" />
                  {st('sweep.weldflow.goalsCanvas.atRisk')}
                </div>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setHighlightStatus('off-track')}>
                <div className="flex items-center gap-2">
                  <div className="w-2.5 h-2.5 rounded-[3px] bg-red-500" />
                  {st('sweep.weldflow.goalsCanvas.offTrack')}
                </div>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setHighlightStatus('not-started')}>
                <div className="flex items-center gap-2">
                  <div className="w-2.5 h-2.5 rounded-[3px] bg-gray-400" />
                  {st('sweep.weldflow.goalsCanvas.notStarted')}
                </div>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setHighlightStatus('completed')}>
                <div className="flex items-center gap-2">
                  <div className="w-2.5 h-2.5 rounded-[3px] bg-blue-500" />
                  {st('sweep.weldflow.goalsCanvas.completed')}
                </div>
              </DropdownMenuItem>
              {highlightStatus !== 'none' && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => setHighlightStatus('none')}
                    className="text-red-600 hover:!bg-red-50 hover:!text-red-600 dark:text-red-400 dark:hover:!bg-red-950 dark:hover:!text-red-400"
                  >
                    <Trash2 className="h-4 w-4 mr-0.5 text-red-500" />
                    {st('sweep.weldflow.timesheetPage.clear')}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="flex items-center gap-2">
          {/* Search */}
          <div className="relative flex items-center">
            <div
              className={cn(
                "flex items-center transition-all duration-200 ease-out",
                searchOpen ? "w-48" : "w-8"
              )}
            >
              <Button
                variant="outline"
                size="sm"
                className={cn(
                  "h-8 w-8 p-0 flex-shrink-0 shadow-none transition-opacity duration-200",
                  searchOpen && "opacity-0 pointer-events-none absolute"
                )}
                onClick={() => setSearchOpen(true)}
              >
                <Search className="h-4 w-4" />
              </Button>
              <div className={cn(
                "relative transition-all duration-200 ease-out",
                searchOpen ? "opacity-100 w-48" : "opacity-0 w-0 pointer-events-none"
              )}>
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <input
                  ref={searchInputRef}
                  type="text"
                  placeholder={st('sweep.weldflow.goalsCanvas.searchGoalsPlaceholder')}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onBlur={() => !searchQuery && setSearchOpen(false)}
                  className="h-8 w-full pl-8 pr-3 text-sm border border-border rounded-md bg-background focus:outline-none"
                />
              </div>
            </div>
          </div>

          {/* Create goal */}
          {canWrite && (
            <Button
              size="sm"
              className="h-8 bg-primary text-primary-foreground hover:bg-primary/90"
              onClick={() => {
                setParentGoalForNewChild(mission.id);
                setShowAddChildModal(true);
              }}
            >
              <Plus className="h-4 w-4 mr-0.5" />
              {st('sweep.weldflow.goalsCanvas.createGoal')}
            </Button>
          )}
        </div>
      </div>

      {/* Canvas wrapper */}
      <div className="flex-1 relative min-h-0">
        {/* Floating zoom controls */}
        <div className="absolute bottom-4 right-4 z-20">
          <div className="flex flex-col bg-white dark:bg-background border border-border rounded-lg overflow-hidden">
            <Button
              variant="ghost"
              onClick={(e) => {
                e.stopPropagation();
                if (zoomIndex < zoomLevels.length - 1) {
                  const newIndex = zoomIndex + 1;
                  const newScale = zoomLevels[newIndex];
                  const scaleRatio = newScale / zoom;
                  const rect = canvasRef.current?.getBoundingClientRect();
                  if (rect) {
                    const centerX = rect.width / 2;
                    const centerY = rect.height / 2;
                    setPanPosition(prev => ({
                      x: centerX - (centerX - prev.x) * scaleRatio,
                      y: centerY - (centerY - prev.y) * scaleRatio
                    }));
                  }
                  setZoom(newScale);
                  setZoomIndex(newIndex);
                  setIsZooming(true);
                  setTimeout(() => setIsZooming(false), 250);
                }
              }}
              className="w-9 h-9 flex items-center justify-center hover:bg-muted transition-colors"
              title={st('sweep.weldflow.goalsCanvas.zoomIn')}
            >
              <Plus className="w-4 h-4 text-foreground" />
            </Button>
            <div className="border-t border-border" />
            <Button
              variant="ghost"
              onClick={(e) => {
                e.stopPropagation();
                if (zoomIndex > 0) {
                  const newIndex = zoomIndex - 1;
                  const newScale = zoomLevels[newIndex];
                  const scaleRatio = newScale / zoom;
                  const rect = canvasRef.current?.getBoundingClientRect();
                  if (rect) {
                    const centerX = rect.width / 2;
                    const centerY = rect.height / 2;
                    setPanPosition(prev => ({
                      x: centerX - (centerX - prev.x) * scaleRatio,
                      y: centerY - (centerY - prev.y) * scaleRatio
                    }));
                  }
                  setZoom(newScale);
                  setZoomIndex(newIndex);
                  setIsZooming(true);
                  setTimeout(() => setIsZooming(false), 250);
                }
              }}
              className="w-9 h-9 flex items-center justify-center hover:bg-muted transition-colors"
              title={st('sweep.weldflow.goalsCanvas.zoomOut')}
            >
              <Minus className="w-4 h-4 text-foreground" />
            </Button>
            <div className="border-t border-border" />
            <Button
              variant="ghost"
              onClick={(e) => {
                e.stopPropagation();
                setZoom(1);
                setZoomIndex(8);
                centerCanvasView();
              }}
              className="w-9 h-9 flex items-center justify-center hover:bg-muted transition-colors"
              title={st('sweep.weldflow.goalsCanvas.fitToView')}
            >
              <Maximize className="w-4 h-4 text-foreground" />
            </Button>
          </div>
        </div>

        {/* Canvas */}
        <div
          ref={canvasRef}
          className="absolute inset-0 overflow-hidden bg-[#fafafa] dark:bg-[#17181a] touch-none"
          style={{
            cursor: isPanning ? 'grabbing' : 'grab'
          }}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onWheel={handleWheel}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
        >
        <div
          className="relative w-full h-full"
          style={{
            transform: `translate(${panPosition.x}px, ${panPosition.y}px) scale(${zoom})`,
            transformOrigin: '0 0',
            transition: isPanning || isDragging || isInitialLoad ? 'none' : (isZooming ? 'transform 0.25s cubic-bezier(0.4, 0, 0.2, 1)' : 'none')
          }}
        >
          {/* Grid pattern background */}
          <svg
            width="10000"
            height="10000"
            style={{
              position: 'absolute',
              left: '-5000px',
              top: '-5000px',
              pointerEvents: 'none'
            }}
          >
            <defs>
              <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
                <circle cx="1" cy="1" r="0.5" fill="#e5e5e5" />
              </pattern>
            </defs>
            <rect width="10000" height="10000" fill="url(#grid)" />
          </svg>
          
          {/* Render connections */}
          {renderConnections()}

          {/* Alignment guides */}
          {alignmentGuides.length > 0 && (
            <svg
              className="absolute pointer-events-none"
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                width: '10000px',
                height: '10000px',
                zIndex: 50,
              }}
            >
              {alignmentGuides.map((guide, index) => (
                <line
                  key={`${guide.type}-${index}`}
                  x1={guide.x}
                  y1={guide.yStart}
                  x2={guide.x}
                  y2={guide.yEnd}
                  stroke="#3b82f6"
                  strokeWidth={1.5}
                  strokeDasharray="6 4"
                />
              ))}
            </svg>
          )}

          {/* Render mission card */}
          {renderMissionCard(mission)}

          {/* Render goal cards */}
          {goals
            .filter(goal => {
              // Filter by time period
              if (selectedTimePeriod !== 'all' && goal.timePeriod !== selectedTimePeriod) {
                return false;
              }

              // Hide child goals if parent is collapsed
              if (goal.parentId) {
                const parent = goals.find(g => g.id === goal.parentId);
                if (parent && collapsedGoals.has(parent.id)) {
                  return false;
                }
              }

              return true;
            })
            .sort((a, b) => {
              // Sort by hierarchy level first (root goals first, then children)
              const aLevel = a.parentId ? 1 : 0;
              const bLevel = b.parentId ? 1 : 0;
              if (aLevel !== bLevel) return aLevel - bLevel;

              // Then sort by y position (top to bottom)
              if (a.y !== b.y) return a.y - b.y;

              // Finally sort by x position (left to right)
              return a.x - b.x;
            })
            .map(renderGoalCard)}

          {/* Add child button - appears on hover, hidden when dragging */}
          {canWrite && hoveredGoal && !isDragging && (() => {
            // Check if hovering over mission card
            const isMission = hoveredGoal === mission.id;
            const goal = isMission ? null : goals.find(g => g.id === hoveredGoal);
            if (!isMission && !goal) return null;

            const buttonX = isMission
              ? mission.x + mission.width / 2
              : goal!.x + goal!.width / 2;
            const buttonY = isMission
              ? mission.y + mission.height
              : goal!.y + goal!.height;

            return (
              <div
                className="absolute pointer-events-auto z-50"
                style={{
                  left: `${buttonX}px`,
                  top: `${buttonY}px`,
                  transform: 'translate(-50%, 0)',
                  paddingTop: '10px'
                }}
                onMouseEnter={() => setHoveredGoal(hoveredGoal)}
                onMouseLeave={() => setHoveredGoal(null)}
              >
                <Button
                  variant="ghost"
                  className="px-3 py-1.5 rounded-md border border-gray-300 bg-white text-xs font-medium text-gray-700 hover:bg-gray-50 hover:border-gray-400 transition-all flex items-center gap-1.5"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (isMission) {
                      setShowCreateGoalModal(true);
                    } else {
                      setParentGoalForNewChild(hoveredGoal);
                      setShowAddChildModal(true);
                    }
                  }}
                >
                  <Plus className="h-3 w-3" />
                  {st('sweep.weldflow.goalsCanvas.addChild')}
                </Button>
              </div>
            );
          })()}
        </div>

      </div>
      </div>

      {/* Unified Detail Panel — mounts on first open and then stays mounted so:
          (1) the initial open plays the slide-in animation, and
          (2) switching between goal and linked-task modes only swaps the task
              prop, avoiding a close/reopen animation. */}
      {(() => {
        const goalForPanel = selectedGoal ? goals.find(g => g.id === selectedGoal) : null;
        const goalAsTask: CrmTask | null = goalForPanel ? (() => {
          const statusMap: Record<string, CrmTask['status']> = {
            'completed': 'done',
            'on-track': 'in_progress',
            'at-risk': 'in_review',
            'off-track': 'in_progress',
            'not-started': 'todo',
          };
          const priorityMap: Record<string, CrmTask['priority']> = {
            low: 'low', medium: 'medium', high: 'high', critical: 'high',
          };
          return {
            id: goalForPanel.id,
            title: goalForPanel.title,
            description: goalForPanel.description,
            status: statusMap[goalForPanel.status] ?? 'todo',
            priority: goalForPanel.priority ? priorityMap[goalForPanel.priority] : undefined,
            assignee: goalForPanel.owner ? { id: goalForPanel.owner.name, name: goalForPanel.owner.name } : undefined,
            dueDate: goalForPanel.dueDate,
            createdAt: goalForPanel.dueDate ?? new Date(),
          };
        })() : null;

        // Goal mode only — real tasks open via `openObjectPanel` and the
        // global stack now. Goals aren't real tasks, so they still need the
        // legacy panel (the unified TaskPanel fetches by id from app-api,
        // which would 404 on a goal id).
        const activeTask = showDetailsPanel ? goalAsTask : null;
        if (activeTask) lastShownPanelTaskRef.current = activeTask;
        const panelTask = activeTask ?? lastShownPanelTaskRef.current;

        return createPortal(
          <TaskDetailPanel
            task={panelTask}
            isOpen={!!activeTask}
            onClose={() => {
              setShowDetailsPanel(false);
              setTimeout(() => setSelectedGoal(null), 200);
            }}
            onUpdate={(taskId, data) => {
              setGoals(prev => prev.map(g => {
                if (g.id !== taskId) return g;
                const next: GoalCard = { ...g };
                if (data.title !== undefined) next.title = data.title;
                if (data.description !== undefined) next.description = data.description;
                return next;
              }));
            }}
            onDelete={(taskId) => {
              setGoalToDelete(taskId);
              setShowDetailsPanel(false);
              setShowDeleteConfirmModal(true);
            }}
            onToggle={(taskId) => toggleGoalComplete(taskId)}
            onDuplicate={() => {}}
            onEdit={() => {}}
            onNavigateToTask={(id) => setSelectedGoal(id)}
            availableAssignees={[]}
            availableCompanies={[]}
            hiddenFields={['labels', 'repeat', 'subtasks', 'assignee']}
            hideCompletionCheckbox
          />,
          document.body
        );
      })()}

      {/* Add Child Goal Modal */}
      <Dialog open={showAddChildModal} onOpenChange={setShowAddChildModal}>
        <DialogContent className="sm:max-w-[460px]">
          <DialogHeader>
            <DialogTitle>{st('sweep.weldflow.goalsCanvas.addChildGoal')}</DialogTitle>
          </DialogHeader>

          <div className="flex items-center gap-6 mt-1 border-b border-border -mx-6 px-6">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setGoalCreationType('existing')}
              className={cn(
                'group relative flex items-center gap-2 pb-2 text-sm font-medium transition-colors',
                goalCreationType === 'existing'
                  ? 'text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <Link2 className="h-4 w-4" />
              <span>{st('sweep.weldflow.goalsCanvas.linkExistingTask')}</span>
              {goalCreationType === 'existing' && (
                <span className="absolute -bottom-px left-0 right-0 h-[2px] bg-foreground" />
              )}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setGoalCreationType('new')}
              className={cn(
                'group relative flex items-center gap-2 pb-2 text-sm font-medium transition-colors',
                goalCreationType === 'new'
                  ? 'text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <Plus className="h-4 w-4" />
              <span>{st('sweep.weldflow.goalsCanvas.createNew')}</span>
              {goalCreationType === 'new' && (
                <span className="absolute -bottom-px left-0 right-0 h-[2px] bg-foreground" />
              )}
            </Button>
          </div>

          <div className="grid gap-4 py-4">
            {goalCreationType === 'new' ? (
              <>
                <div className="grid gap-2">
                  <Label htmlFor="goal-title">{st('sweep.weldflow.goalsCanvas.goalTitle')}</Label>
                  <Input
                    id="goal-title"
                    placeholder={st('sweep.weldflow.goalsCanvas.goalTitlePlaceholder')}
                    value={newGoalTitle}
                    onChange={(e) => setNewGoalTitle(e.target.value)}
                    autoFocus
                  />
                </div>
              </>
            ) : (
              <div className="grid gap-2">
                <Label>{st('sweep.weldflow.goalsCanvas.selectTask')}</Label>
                <Popover open={taskPickerOpen} onOpenChange={setTaskPickerOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      role="combobox"
                      aria-expanded={taskPickerOpen}
                      className="justify-between font-normal"
                    >
                      <span className={cn('truncate', !selectedExistingTask && 'text-muted-foreground')}>
                        {selectedExistingTask
                          ? existingTasks.find((t) => t.id === selectedExistingTask)?.title ?? st('sweep.weldflow.goalsCanvas.chooseTaskToLink')
                          : st('sweep.weldflow.goalsCanvas.chooseTaskToLink')}
                      </span>
                      <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent
                    className="w-[var(--radix-popover-trigger-width)] p-0"
                    align="start"
                    onWheel={(e) => e.stopPropagation()}
                    onTouchMove={(e) => e.stopPropagation()}
                  >
                    <Command>
                      <CommandInput placeholder={st('sweep.weldflow.goalsCanvas.searchTasksPlaceholder')} />
                      <CommandList className="max-h-[240px] overflow-y-auto overscroll-contain">
                        <CommandEmpty>{st('sweep.weldflow.goalsCanvas.noTasksFound')}</CommandEmpty>
                        <CommandGroup className="p-1">
                          {existingTasks.map((task) => (
                            <CommandItem
                              key={task.id}
                              value={task.title}
                              onSelect={() => {
                                setSelectedExistingTask(task.id);
                                setTaskPickerOpen(false);
                              }}
                            >
                              <span
                                className="h-2 w-2 shrink-0 rounded-[3px]"
                                style={{
                                  backgroundColor: task.priority
                                    ? TASK_PRIORITY_COLORS[task.priority] ?? TASK_NO_PRIORITY_COLOR
                                    : TASK_NO_PRIORITY_COLOR,
                                }}
                              />
                              <span className="truncate">{task.title}</span>
                              {selectedExistingTask === task.id && (
                                <Check className="ml-auto h-4 w-4" />
                              )}
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setShowAddChildModal(false);
                setNewGoalTitle('');
                setNewGoalTarget('');
                setParentGoalForNewChild(null);
                setGoalCreationType('existing');
                setSelectedExistingTask(null);
              }}
            >
              {st('sweep.weldflow.cancel')}
            </Button>
            <Button
              onClick={() => {
                if (parentGoalForNewChild) {
                  const isRoot = parentGoalForNewChild === mission.id;
                  if (goalCreationType === 'new' && newGoalTitle.trim()) {
                    if (isRoot) {
                      addRootGoal(newGoalTitle, newGoalTarget);
                    } else {
                      addChildGoal(parentGoalForNewChild, newGoalTitle, newGoalTarget);
                    }
                    setShowAddChildModal(false);
                    setNewGoalTitle('');
                    setNewGoalTarget('');
                    setParentGoalForNewChild(null);
                    setGoalCreationType('existing');
                  } else if (goalCreationType === 'existing' && selectedExistingTask) {
                    const task = existingTasks.find(t => t.id === selectedExistingTask);
                    if (task) {
                      if (isRoot) {
                        addRootGoal(task.title, '1', task.id);
                      } else {
                        addChildGoal(parentGoalForNewChild, task.title, '1', task.id);
                      }
                      setShowAddChildModal(false);
                      setSelectedExistingTask(null);
                      setParentGoalForNewChild(null);
                      setGoalCreationType('existing');
                    }
                  }
                }
              }}
              disabled={goalCreationType === 'new' ? !newGoalTitle.trim() : !selectedExistingTask}
            >
              {goalCreationType === 'new' ? st('sweep.weldflow.goalsCanvas.createGoal') : st('sweep.weldflow.goalsCanvas.linkTask')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create Goal Modal (root-level goal) */}
      <Dialog open={showCreateGoalModal} onOpenChange={setShowCreateGoalModal}>
        <DialogContent className="sm:max-w-[460px]">
          <DialogHeader>
            <DialogTitle>{st('sweep.weldflow.goalsCanvas.createGoal')}</DialogTitle>
          </DialogHeader>

          <div className="grid gap-4 pt-2 pb-4">
            <div className="grid gap-2">
              <Label htmlFor="new-goal-title">{st('sweep.weldflow.goalsCanvas.goalTitle')}</Label>
              <Input
                id="new-goal-title"
                placeholder={st('sweep.weldflow.goalsCanvas.rootGoalTitlePlaceholder')}
                value={newGoalTitle}
                onChange={(e) => setNewGoalTitle(e.target.value)}
                autoFocus
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setShowCreateGoalModal(false);
                setNewGoalTitle('');
                setNewGoalTarget('');
              }}
            >
              {st('sweep.weldflow.cancel')}
            </Button>
            <Button
              onClick={() => {
                if (newGoalTitle.trim()) {
                  addRootGoal(newGoalTitle, newGoalTarget);
                  setShowCreateGoalModal(false);
                  setNewGoalTitle('');
                  setNewGoalTarget('');
                }
              }}
              disabled={!newGoalTitle.trim()}
            >
              {st('sweep.weldflow.goalsCanvas.createGoal')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Modal */}
      <Dialog open={showDeleteConfirmModal} onOpenChange={setShowDeleteConfirmModal}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>{st('sweep.weldflow.goalsCanvas.deleteGoal')}</DialogTitle>
            <DialogDescription>
              {st('sweep.weldflow.goalsCanvas.deleteGoalConfirm')}
              {goalToDelete && (() => {
                const childCount = goals.filter(g => g.parentId === goalToDelete).length;
                if (childCount > 0) {
                  return (
                    <span className="block mt-2 text-destructive font-medium">
                      {st('sweep.weldflow.goalsCanvas.deleteChildGoalsWarning', { count: childCount })}
                    </span>
                  );
                }
                return null;
              })()}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setShowDeleteConfirmModal(false);
                setGoalToDelete(null);
              }}
            >
              {st('sweep.weldflow.cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (goalToDelete) {
                  deleteGoal(goalToDelete);
                  setShowDeleteConfirmModal(false);
                  setGoalToDelete(null);
                }
              }}
            >
              {st('sweep.weldflow.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}