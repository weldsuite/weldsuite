
import {
  GanttHeader,
  GanttProvider,
  GanttSidebar,
  GanttTimeline,
  GanttToday,
  GanttFeatureItem,
  GanttMarker,
  GanttCreateMarkerTrigger,
  useGantt,
  type GanttFeature,
} from '@weldsuite/ui/components/gantt';
import { Check, ChevronDown, ChevronRight, MinusIcon, PlusIcon, AlertCircle, Search, CalendarIcon, SquarePen, Trash2 } from 'lucide-react';
import { useState, useRef, useEffect, useMemo, useCallback, memo } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import { FilterPills, type ActiveFilter, type FilterConfig } from '@/components/entity-list';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@weldsuite/ui/components/popover';
import { EntityDetailPanel, type EntityField, type Comment, type ActivityItem } from '@weldsuite/ui/components/entity-detail-panel';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { cn } from '@/lib/utils';
import { format, formatDistance } from 'date-fns';
import {
  startOfDay,
  addDays,
  isWithinInterval,
  eachDayOfInterval,
  isSameDay,
} from 'date-fns';
import type { Projects } from "@/lib/api/types/apps/projects.types";
import { ganttApi } from '@/app/weldflow/lib/api-client';
import { toast } from 'sonner';
import { Separator } from '@weldsuite/ui/components/separator';
import { Calendar as CalendarPicker } from '@weldsuite/ui/components/calendar';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { useTranslations } from '@weldsuite/i18n/client';

// Internal types derived from API data
interface TeamMember {
  id: string;
  name: string;
  image?: string;
  role: string;
  hoursPerDay: number;
}

interface Task {
  id: string;
  name: string;
  assigneeId: string;
  startAt: Date;
  endAt: Date;
  hoursPerDay: number;
  color: string;
  projectName?: string;
}

// Color palette for tasks
const TASK_COLORS = [
  '#93c5fd', '#c4b5fd', '#5eead4', '#fdba74', '#fca5a5',
  '#86efac', '#fcd34d', '#f9a8d4', '#a5b4fc', '#67e8f9',
];

// Transform API data to internal format
function transformApiData(data: Projects.WorkloadOverview | null): { members: TeamMember[], tasks: Task[] } {
  if (!data || !data.teamMembers) {
    return { members: [], tasks: [] };
  }

  const members: TeamMember[] = data.teamMembers.map(member => ({
    id: member.userId,
    name: member.name,
    image: member.avatar,
    role: member.role || 'Team Member',
    hoursPerDay: member.capacity ? member.capacity / 5 : 8, // Convert weekly capacity to daily (assuming 5-day week)
  }));

  const tasks: Task[] = [];
  let colorIndex = 0;

  data.teamMembers.forEach(member => {
    if (member.tasks) {
      member.tasks.forEach(task => {
        const now = new Date();
        // Use actual start/due dates with sensible fallbacks
        const startAt = task.startDate ? new Date(task.startDate) : (task.dueDate ? addDays(new Date(task.dueDate), -7) : now);
        const endAt = task.dueDate ? new Date(task.dueDate) : (task.startDate ? addDays(new Date(task.startDate), 7) : addDays(now, 7));

        // Calculate hours per day based on estimated hours and duration
        const durationDays = Math.max(1, Math.ceil((endAt.getTime() - startAt.getTime()) / (1000 * 60 * 60 * 24)));
        const hoursPerDay = task.estimatedHours ? task.estimatedHours / durationDays : 2;

        tasks.push({
          id: task.id,
          name: task.title,
          assigneeId: member.userId,
          startAt,
          endAt,
          hoursPerDay: Math.min(hoursPerDay, member.capacity ? member.capacity / 5 : 8), // Cap at member's daily capacity
          color: TASK_COLORS[colorIndex % TASK_COLORS.length],
          projectName: task.projectName,
        });
        colorIndex++;
      });
    }
  });

  return { members, tasks };
}

// Workload calculation utilities
const calculateDailyWorkload = (
  memberId: string,
  tasks: Task[],
  date: Date
): { totalHours: number; tasks: Task[] } => {
  const memberTasks = tasks.filter(
    (task) =>
      task.assigneeId === memberId &&
      isWithinInterval(date, { start: startOfDay(task.startAt), end: startOfDay(task.endAt) })
  );

  const totalHours = memberTasks.reduce((sum, task) => sum + task.hoursPerDay, 0);
  return { totalHours, tasks: memberTasks };
};

// Task sidebar item (Gantt style)
const TaskSidebarItem = memo(({
  task,
  rowHeight,
  isSelected,
  onClick,
}: {
  task: Task;
  rowHeight: number;
  isSelected?: boolean;
  onClick?: () => void;
}) => {
  const tempEndAt =
    task.endAt && isSameDay(task.startAt, task.endAt)
      ? addDays(task.endAt, 1)
      : task.endAt;
  const duration = tempEndAt
    ? formatDistance(task.startAt, tempEndAt)
    : `${formatDistance(task.startAt, new Date())} so far`;

  return (
    <div
      className={cn(
        "flex items-center gap-2.5 p-2.5 text-xs hover:bg-secondary pl-6 cursor-pointer transition-colors",
        isSelected && "bg-secondary"
      )}
      style={{ height: rowHeight }}
      onClick={onClick}
    >
      <div
        className="shrink-0 rounded-full h-1.5 w-1.5"
        style={{ backgroundColor: task.color }}
      />
      <p className="flex-1 truncate text-left text-muted-foreground">
        {task.name}
      </p>
      <p className="text-muted-foreground">{duration}</p>
    </div>
  );
});

TaskSidebarItem.displayName = 'TaskSidebarItem';

// Team member sidebar item
const TeamMemberSidebarItem = memo(({
  member,
  tasks,
  rowHeight,
  isExpanded,
  onToggle,
}: {
  member: TeamMember;
  tasks: Task[];
  rowHeight: number;
  isExpanded: boolean;
  onToggle: () => void;
}) => {
  const avgWorkload = useMemo(() => {
    const today = new Date();
    const workload = calculateDailyWorkload(member.id, tasks, today);
    return workload.totalHours;
  }, [member.id, tasks]);

  const memberTasks = useMemo(() => {
    return tasks.filter((task) => task.assigneeId === member.id);
  }, [tasks, member.id]);

  return (
    <div
      className="border-b border-border/50 flex items-center gap-3 px-3 cursor-pointer hover:bg-secondary/50"
      style={{ height: rowHeight }}
      onClick={onToggle}
    >
      <Button variant="ghost" className="h-5 w-5 flex items-center justify-center text-muted-foreground rounded-[5px] hover:bg-black/5 dark:hover:bg-white/5 transition-colors p-0">
        {isExpanded ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" />
        )}
      </Button>
      <Avatar className="h-[30px] w-[30px] rounded-lg -ml-1">
        {member.image && <AvatarImage src={member.image} className="rounded-lg" />}
        <AvatarFallback className="rounded-lg text-xs">{(member.name ?? '?').slice(0, 2)}</AvatarFallback>
      </Avatar>
      <div className="flex-1 min-w-0 -space-y-px -ml-1">
        <p className="text-sm font-medium truncate">{member.name}</p>
        <p className="text-xs text-muted-foreground">{member.role}</p>
      </div>
      <div className="text-right space-y-0.5">
        <p className={cn(
          "text-xs font-medium",
          avgWorkload > member.hoursPerDay ? "text-red-500" : avgWorkload > member.hoursPerDay * 0.8 ? "text-green-500" : "text-muted-foreground"
        )}>
          {avgWorkload.toFixed(1)}h / {member.hoursPerDay}h
        </p>
        <p className="text-xs text-muted-foreground">{memberTasks.length} tasks</p>
      </div>
    </div>
  );
});

TeamMemberSidebarItem.displayName = 'TeamMemberSidebarItem';

// Workload area chart component for a team member
const WorkloadAreaChart = memo(({
  member,
  tasks,
  rowHeight,
}: {
  member: TeamMember;
  tasks: Task[];
  rowHeight: number;
}) => {
  const gantt = useGantt();
  const { columnWidth, zoom, range, timelineData } = gantt;
  const [hoveredDate, setHoveredDate] = useState<Date | null>(null);
  const [tooltipPosition, setTooltipPosition] = useState({ x: 0, y: 0 });
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [tooltipFlipBelow, setTooltipFlipBelow] = useState(false);

  // Calculate the effective column width with zoom
  const effectiveColumnWidth = (columnWidth * zoom) / 100;

  // Get the timeline start date from gantt context
  const timelineStartDate = useMemo(() => {
    if (!timelineData || timelineData.length === 0) return new Date(2024, 0, 1);
    return new Date(timelineData[0].year, 0, 1);
  }, [timelineData]);

  // Generate dates for the full timeline range (3 years)
  const dates = useMemo(() => {
    const startDate = timelineStartDate;
    const endDate = addDays(startDate, 365 * 3);
    return eachDayOfInterval({ start: startDate, end: endDate });
  }, [timelineStartDate]);

  // Calculate workload for each date
  const workloadData = useMemo(() => {
    return dates.map((date) => {
      const workload = calculateDailyWorkload(member.id, tasks, date);
      const utilizationPercent = (workload.totalHours / member.hoursPerDay) * 100;
      return {
        date,
        hours: workload.totalHours,
        utilization: utilizationPercent,
        tasks: workload.tasks,
      };
    });
  }, [dates, member.id, member.hoursPerDay, tasks]);

  // Calculate pixel width per day based on range and zoom
  const pixelsPerDay = useMemo(() => {
    if (range === 'daily') {
      return effectiveColumnWidth;
    } else if (range === 'monthly') {
      return effectiveColumnWidth / 30;
    } else {
      return effectiveColumnWidth / 90;
    }
  }, [range, effectiveColumnWidth]);

  // Create SVG path for the area chart
  const { areaPath, linePath, svgWidth } = useMemo(() => {
    const maxHeight = rowHeight - 4;
    const maxUtilization = 150;
    const bottomY = rowHeight;

    if (workloadData.length === 0) return { areaPath: '', linePath: '', svgWidth: 0 };

    const width = workloadData.length * pixelsPerDay;

    // Build points array with changes only
    const segments: { startX: number; endX: number; y: number }[] = [];
    let currentUtil = workloadData[0].utilization;
    let segmentStart = 0;

    for (let i = 1; i < workloadData.length; i++) {
      if (Math.abs(workloadData[i].utilization - currentUtil) > 0.1) {
        const utilClamped = Math.min(currentUtil, maxUtilization);
        const y = bottomY - (utilClamped / maxUtilization) * maxHeight;
        segments.push({ startX: segmentStart * pixelsPerDay, endX: i * pixelsPerDay, y });
        segmentStart = i;
        currentUtil = workloadData[i].utilization;
      }
    }
    // Add final segment
    const utilClamped = Math.min(currentUtil, maxUtilization);
    const y = bottomY - (utilClamped / maxUtilization) * maxHeight;
    segments.push({ startX: segmentStart * pixelsPerDay, endX: width, y });

    // Build path
    let area = `M 0 ${bottomY}`;
    let line = '';

    segments.forEach((seg, i) => {
      if (i === 0) {
        area += ` L ${seg.startX} ${seg.y}`;
        line = `M ${seg.startX} ${seg.y}`;
      }
      area += ` L ${seg.endX} ${seg.y}`;
      line += ` L ${seg.endX} ${seg.y}`;

      // Vertical line to next segment if exists
      if (i < segments.length - 1) {
        const nextSeg = segments[i + 1];
        area += ` L ${seg.endX} ${nextSeg.y}`;
        line += ` L ${seg.endX} ${nextSeg.y}`;
      }
    });

    area += ` L ${width} ${bottomY} Z`;

    return { areaPath: area, linePath: line, svgWidth: width };
  }, [workloadData, pixelsPerDay, rowHeight]);

  // Handle mouse move to show tooltip
  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const dayIndex = Math.floor(x / pixelsPerDay);

    if (dayIndex >= 0 && dayIndex < workloadData.length) {
      setHoveredDate(workloadData[dayIndex].date);
      setTooltipPosition({ x: e.clientX, y: e.clientY });
    }
  };

  const handleMouseLeave = () => {
    setHoveredDate(null);
  };

  // Get workload data for hovered date
  const hoveredWorkload = useMemo(() => {
    if (!hoveredDate) return null;
    return workloadData.find(d => d.date.getTime() === hoveredDate.getTime());
  }, [hoveredDate, workloadData]);

  // Decide whether to show tooltip above or below cursor based on available space.
  // Re-measures whenever the hovered day or content changes so tall tooltips
  // (many tasks) flip below instead of clipping off the top of the viewport.
  useEffect(() => {
    if (!hoveredDate || !tooltipRef.current) return;
    const height = tooltipRef.current.offsetHeight;
    const spaceAbove = tooltipPosition.y - 20;
    setTooltipFlipBelow(height > spaceAbove);
  }, [hoveredDate, tooltipPosition.y, hoveredWorkload]);

  if (svgWidth === 0) return null;

  return (
    <>
      {/* Interactive overlay for hover detection */}
      <div
        className="absolute inset-0 cursor-crosshair z-10"
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
      />

      {/* SVG chart */}
      <svg
        className="absolute inset-0 pointer-events-none"
        width={svgWidth}
        height={rowHeight}
        style={{ overflow: 'visible' }}
      >
        {/* Area fill */}
        <path
          d={areaPath}
          fill="rgba(99, 102, 241, 0.3)"
        />
        {/* Top line */}
        <path
          d={linePath}
          fill="none"
          stroke="rgb(99, 102, 241)"
          strokeWidth="2"
        />

        {/* Hover indicator line */}
        {hoveredDate && hoveredWorkload && (
          <line
            x1={dates.findIndex(d => d.getTime() === hoveredDate.getTime()) * pixelsPerDay}
            y1={0}
            x2={dates.findIndex(d => d.getTime() === hoveredDate.getTime()) * pixelsPerDay}
            y2={rowHeight}
            stroke="rgb(99, 102, 241)"
            strokeWidth="1"
            strokeDasharray="4 2"
          />
        )}
      </svg>

      {/* Tooltip */}
      {hoveredDate && hoveredWorkload && (() => {
        const status = hoveredWorkload.utilization > 100
          ? 'overloaded'
          : hoveredWorkload.utilization >= 80
            ? 'near'
            : hoveredWorkload.utilization > 0
              ? 'available'
              : 'empty';

        const statusLabel = {
          overloaded: 'Overloaded',
          near: 'Near capacity',
          available: 'Available',
          empty: 'No load',
        }[status];

        const statusLabelClass = {
          overloaded: 'bg-red-50 dark:bg-red-950 text-red-600 dark:text-red-400',
          near: 'bg-orange-50 dark:bg-orange-950 text-orange-600 dark:text-orange-400',
          available: 'bg-blue-50 dark:bg-blue-950 text-blue-600 dark:text-blue-400',
          empty: 'bg-gray-100 dark:bg-secondary text-gray-600 dark:text-muted-foreground',
        }[status];

        const barColorClass = {
          overloaded: 'bg-red-500',
          near: 'bg-amber-500',
          available: 'bg-emerald-500',
          empty: 'bg-muted-foreground/30',
        }[status];

        const overHours = hoveredWorkload.hours - member.hoursPerDay;
        const totalTaskHours = hoveredWorkload.tasks.reduce((sum, t) => sum + t.hoursPerDay, 0);

        return (
          <div
            ref={tooltipRef}
            className="fixed z-50 bg-popover text-popover-foreground border rounded-xl shadow-2xl pointer-events-none min-w-[280px] max-w-[320px] overflow-hidden flex flex-col"
            style={{
              left: tooltipPosition.x + 14,
              top: tooltipFlipBelow ? tooltipPosition.y + 14 : tooltipPosition.y - 14,
              transform: tooltipFlipBelow ? 'none' : 'translateY(-100%)',
              maxHeight: 'calc(100vh - 24px)',
            }}
          >
            {/* Header */}
            <div className="px-3.5 py-2.5 border-b">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-medium truncate tabular-nums">
                  {format(hoveredDate, 'EEE, MMM d, yyyy')}
                </p>
                <span className={cn("px-2 py-0.5 rounded text-[12px] font-medium shrink-0", statusLabelClass)}>
                  {statusLabel}
                </span>
              </div>
            </div>

            {/* Capacity */}
            <div className="px-3.5 py-2.5 border-b">
              <div className="flex items-baseline justify-between mb-1.5">
                <div className="flex items-baseline gap-1">
                  <span className={cn(
                    "text-sm font-semibold tabular-nums",
                    status === 'overloaded' ? "text-red-600 dark:text-red-400" : "text-foreground"
                  )}>
                    {hoveredWorkload.hours.toFixed(1)}h
                  </span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    / {member.hoursPerDay}h
                  </span>
                </div>
                {status === 'overloaded' ? (
                  <span className="text-[11px] font-medium text-red-600 dark:text-red-400 tabular-nums">
                    +{overHours.toFixed(1)}h over
                  </span>
                ) : (status === 'available' || status === 'near') ? (
                  <span className="text-[11px] text-muted-foreground tabular-nums">
                    {(-overHours).toFixed(1)}h left
                  </span>
                ) : null}
              </div>
              <div className="relative h-1 bg-muted rounded-full overflow-hidden">
                <div
                  className={cn("absolute inset-y-0 left-0 rounded-full transition-all", barColorClass)}
                  style={{ width: `${Math.min(hoveredWorkload.utilization, 100)}%` }}
                />
              </div>
            </div>

            {/* Tasks */}
            <div className="px-3.5 py-2.5 flex-1 min-h-0 overflow-y-auto">
              {hoveredWorkload.tasks.length > 0 ? (
                <>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      {hoveredWorkload.tasks.length} Task{hoveredWorkload.tasks.length !== 1 ? 's' : ''}
                    </span>
                    <span className="text-[11px] text-muted-foreground tabular-nums">
                      {totalTaskHours.toFixed(1)}h total
                    </span>
                  </div>
                  <div className="space-y-0.5">
                    {hoveredWorkload.tasks.map((task) => (
                      <div key={task.id} className="flex items-center gap-2.5 py-1">
                        <div
                          className="w-2.5 h-2.5 rounded-[3px] shrink-0 ring-1 ring-inset ring-black/5"
                          style={{ backgroundColor: task.color }}
                        />
                        <div className="flex-1 min-w-0">
                          <div className="text-sm truncate leading-tight">{task.name}</div>
                        </div>
                        <span className="text-xs font-medium text-muted-foreground tabular-nums shrink-0">
                          {task.hoursPerDay.toFixed(1)}h
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <div className="flex items-center gap-2 text-muted-foreground py-1">
                  <div className="w-2.5 h-2.5 rounded-[3px] bg-muted" />
                  <span className="text-sm">No tasks scheduled</span>
                </div>
              )}
            </div>
          </div>
        );
      })()}
    </>
  );
});

WorkloadAreaChart.displayName = 'WorkloadAreaChart';

// Task row component for the timeline (Gantt style bar)
const TaskTimelineRow = memo(({
  task,
  rowHeight,
}: {
  task: Task;
  rowHeight: number;
}) => {
  // Convert task to GanttFeature format
  const feature: GanttFeature = useMemo(() => ({
    id: task.id,
    name: task.name,
    startAt: task.startAt,
    endAt: task.endAt,
    status: {
      id: 'active',
      name: 'Active',
      color: task.color,
    },
  }), [task]);

  return (
    <div
      className="relative w-full"
      style={{ height: rowHeight }}
    >
      <GanttFeatureItem {...feature}>
        <p className="flex-1 truncate text-xs">{task.name}</p>
      </GanttFeatureItem>
    </div>
  );
});

TaskTimelineRow.displayName = 'TaskTimelineRow';

const ROW_HEIGHT = 60;
const TASK_ROW_HEIGHT = 36;

// Milestone types and helpers
interface GanttMarkerType {
  id: string;
  date: Date;
  label: string;
  className: string;
  originalMilestone?: any;
}

const milestoneStatusColors: Record<string, string> = {
  planned: 'bg-purple-100 text-purple-900',
  pending: 'bg-yellow-100 text-yellow-900',
  in_progress: 'bg-blue-100 text-blue-900',
  completed: 'bg-green-100 text-green-900',
  missed: 'bg-red-100 text-red-900',
  postponed: 'bg-orange-100 text-orange-900',
};

const markerColors = [
  { name: 'Blue', className: 'bg-blue-100 text-blue-900', color: '#dbeafe' },
  { name: 'Green', className: 'bg-green-100 text-green-900', color: '#dcfce7' },
  { name: 'Purple', className: 'bg-purple-100 text-purple-900', color: '#f3e8ff' },
  { name: 'Red', className: 'bg-red-100 text-red-900', color: '#fee2e2' },
  { name: 'Orange', className: 'bg-orange-100 text-orange-900', color: '#ffedd5' },
  { name: 'Teal', className: 'bg-teal-100 text-teal-900', color: '#ccfbf1' },
  { name: 'Yellow', className: 'bg-yellow-100 text-yellow-900', color: '#fef9c3' },
  { name: 'Pink', className: 'bg-pink-100 text-pink-900', color: '#fce7f3' },
];

function mapMilestoneToMarker(milestone: any): GanttMarkerType {
  const dueDate = milestone.dueDate ? new Date(milestone.dueDate) : new Date();
  const statusClass = milestoneStatusColors[milestone.status] || milestoneStatusColors.planned;
  return {
    id: milestone.id,
    date: dueDate,
    label: milestone.name || 'Untitled Milestone',
    className: statusClass,
    originalMilestone: milestone,
  };
}

interface TaskComment extends Comment {
  taskId: string;
}

// Task detail side panel component
const TaskDetailPanel = memo(({
  task,
  member,
  onClose,
  comments,
  commentInput,
  onCommentInputChange,
  onSendComment,
}: {
  task: Task | null;
  member: TeamMember | null;
  onClose: () => void;
  comments: TaskComment[];
  commentInput: string;
  onCommentInputChange: (value: string) => void;
  onSendComment: () => void;
}) => {
  if (!task || !member) return null;

  const tempEndAt =
    task.endAt && isSameDay(task.startAt, task.endAt)
      ? addDays(task.endAt, 1)
      : task.endAt;

  // Prepare fields for the detail panel
  const fields: EntityField[] = [
    {
      label: 'Assignee',
      value: (
        <div className="flex items-center gap-2">
          <Avatar className="h-6 w-6 rounded-md">
            {member.image && <AvatarImage src={member.image} className="rounded-md" />}
            <AvatarFallback className="rounded-md text-[10px]">{member.name.slice(0, 2)}</AvatarFallback>
          </Avatar>
          <span className="text-sm">{member.name}</span>
        </div>
      )
    },
    {
      label: 'Due date',
      value: `${format(task.startAt, 'MMM d')} - ${format(task.endAt, 'MMM d, yyyy')}`
    },
    {
      label: 'Project',
      value: task.projectName || 'No project'
    },
    {
      label: 'Status',
      value: (
        <span className="text-green-600">In Progress</span>
      )
    }
  ];

  // Prepare activities
  const activities: ActivityItem[] = [
    {
      id: 'created',
      author: {
        name: member.name,
        initials: member.name.slice(0, 2),
        color: '#8b5cf6'
      },
      action: 'created this task',
      timestamp: '6 days ago'
    },
    {
      id: 'assigned',
      author: {
        name: member.name,
        initials: member.name.slice(0, 2),
        color: '#8b5cf6'
      },
      action: `assigned to ${member.name}`,
      timestamp: '5 days ago'
    }
  ];

  return (
    <EntityDetailPanel
      isOpen={!!task}
      onClose={onClose}
      title={task.name}
      topOffset="90px"
      visibilityText="This task is visible to everyone."
      isCompleted={false}
      onToggleComplete={() => {}}
      fields={fields}
      descriptionValue=""
      onDescriptionChange={() => {}}
      descriptionPlaceholder="Add a description..."
      comments={comments}
      commentInput={commentInput}
      onCommentInputChange={onCommentInputChange}
      onSendComment={onSendComment}
      activities={activities}
      onShare={() => {}}
      onCopyLink={() => {}}
      onMaximize={() => {}}
    />
  );
});

TaskDetailPanel.displayName = 'TaskDetailPanel';

export interface WorkloadViewProps {
  initialData: Projects.WorkloadOverview | null;
  error: string | null;
  projectId?: string;
}

export function WorkloadView({ initialData, error, projectId }: WorkloadViewProps) {
  const st = useTranslations();
  // Transform API data to internal format
  const { members: teamMembers, tasks } = useMemo(
    () => transformApiData(initialData),
    [initialData]
  );
  const [viewMode, setViewMode] = useState<'daily' | 'weekly' | 'monthly' | 'quarterly'>('monthly');
  const [zoom, setZoom] = useState(100);
  const [expandedMembers, setExpandedMembers] = useState<Set<string>>(new Set());
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [comments, setComments] = useState<TaskComment[]>([]);
  const [commentInput, setCommentInput] = useState('');
  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Milestone state
  const [markers, setMarkers] = useState<GanttMarkerType[]>([]);
  const [selectedMarker, setSelectedMarker] = useState<GanttMarkerType | null>(null);
  const [viewMarkerPopoverOpen, setViewMarkerPopoverOpen] = useState(false);
  const [markerPopoverPosition, setMarkerPopoverPosition] = useState<{ x: number; y: number } | null>(null);
  const [markerDatePickerOpen, setMarkerDatePickerOpen] = useState(false);
  const [renameMarkerDialogOpen, setRenameMarkerDialogOpen] = useState(false);
  const [newName, setNewName] = useState('');

  useEffect(() => {
    if (searchOpen && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [searchOpen]);

  // Load milestones from API
  const loadMilestones = useCallback(async () => {
    if (!projectId) return;
    try {
      const result = await ganttApi.getMilestones(projectId);
      if (result.success && result.data) {
        setMarkers(result.data.map(mapMilestoneToMarker));
      }
    } catch (err) {
      console.error('Failed to load milestones:', err);
    }
  }, [projectId]);

  useEffect(() => {
    loadMilestones();
  }, [loadMilestones]);

  // Milestone handlers
  const handleCreateMarker = useCallback(async (date: Date) => {
    if (!projectId) return;
    const tempId = `temp-${Date.now()}`;
    const newMarker: GanttMarkerType = {
      id: tempId,
      date,
      label: st('sweep.weldflow.workloadView.newMilestone'),
      className: 'bg-purple-100 text-purple-900',
    };
    setMarkers((prev) => [...prev, newMarker]);

    const result = await ganttApi.createMilestone(projectId, {
      name: st('sweep.weldflow.workloadView.newMilestone'),
      dueDate: date.toISOString(),
    });
    if (result.success && result.data) {
      setMarkers((prev) => prev.map((m) => (m.id === tempId ? mapMilestoneToMarker(result.data) : m)));
      toast.success(st('sweep.weldflow.workloadView.milestoneCreated'));
    } else {
      setMarkers((prev) => prev.filter((m) => m.id !== tempId));
      toast.error(st('sweep.weldflow.workloadView.milestoneCreateFailed'));
    }
  }, [projectId, st]);

  const handleRemoveMarker = useCallback(async (id: string) => {
    if (!projectId) return;
    setMarkers((prev) => prev.filter((m) => m.id !== id));
    const result = await ganttApi.deleteMilestone(projectId, id);
    if (result.success) {
      toast.success(st('sweep.weldflow.workloadView.milestoneDeleted'));
    } else {
      toast.error(st('sweep.weldflow.workloadView.milestoneDeleteFailed'));
      loadMilestones();
    }
  }, [projectId, loadMilestones, st]);

  const handleViewMarker = useCallback((id: string, event?: React.MouseEvent) => {
    const marker = markers.find((m) => m.id === id);
    if (marker) {
      setSelectedMarker(marker);
      if (event) {
        setMarkerPopoverPosition({ x: event.clientX, y: event.clientY });
      }
      setViewMarkerPopoverOpen(true);
    }
  }, [markers]);

  const handleRenameMarker = useCallback((id: string) => {
    const marker = markers.find((m) => m.id === id);
    if (marker) {
      setSelectedMarker(marker);
      setNewName(marker.label);
      setRenameMarkerDialogOpen(true);
    }
  }, [markers]);

  const handleSaveMarkerRename = useCallback(async () => {
    if (!projectId || !selectedMarker || !newName.trim()) return;
    setMarkers((prev) => prev.map((m) => m.id === selectedMarker.id ? { ...m, label: newName.trim() } : m));
    setRenameMarkerDialogOpen(false);

    const result = await ganttApi.updateMilestone(projectId, selectedMarker.id, { name: newName.trim() });
    if (result.success) {
      toast.success(st('sweep.weldflow.workloadView.milestoneRenamed'));
    } else {
      toast.error(st('sweep.weldflow.workloadView.milestoneRenameFailed'));
    }
    setSelectedMarker(null);
    setNewName('');
  }, [projectId, selectedMarker, newName, st]);

  const handleChangeMarkerDate = useCallback(async (markerId: string, newDate: Date) => {
    if (!projectId) return;
    setMarkers((prev) => prev.map((m) => m.id === markerId ? { ...m, date: newDate } : m));
    setSelectedMarker((prev) => prev?.id === markerId ? { ...prev, date: newDate } : prev);

    const result = await ganttApi.updateMilestone(projectId, markerId, { dueDate: newDate.toISOString() });
    if (result.success) {
      toast.success(st('sweep.weldflow.workloadView.milestoneDateUpdated'));
    } else {
      toast.error(st('sweep.weldflow.workloadView.milestoneDateUpdateFailed'));
      loadMilestones();
    }
  }, [projectId, loadMilestones, st]);

  const handleChangeMarkerColor = useCallback((markerId: string, colorClassName: string) => {
    setMarkers((prev) => prev.map((m) => m.id === markerId ? { ...m, className: colorClassName } : m));
    setSelectedMarker((prev) => prev?.id === markerId ? { ...prev, className: colorClassName } : prev);
  }, []);

  const filterConfigs: FilterConfig[] = useMemo(() => [
    {
      field: 'role',
      label: st('sweep.weldflow.workloadView.role'),
      options: [...new Set(teamMembers.map(m => m.role))].map(role => ({
        value: role,
        label: role,
      })),
    },
    {
      field: 'workload',
      label: st('sweep.weldflow.workloadView.workload'),
      options: [
        { value: 'overloaded', label: st('sweep.weldflow.workloadView.overloaded') },
        { value: 'optimal', label: st('sweep.weldflow.workloadView.optimal') },
        { value: 'underloaded', label: st('sweep.weldflow.workloadView.underloaded') },
      ],
    },
  ], [teamMembers, st]);

  const range = viewMode === 'weekly' ? 'daily' : viewMode;
  const effectiveZoom = viewMode === 'weekly' ? Math.max(100, zoom * 1.5) : zoom;

  const toggleMember = (memberId: string) => {
    setExpandedMembers((prev) => {
      const next = new Set(prev);
      if (next.has(memberId)) {
        next.delete(memberId);
      } else {
        next.add(memberId);
      }
      return next;
    });
  };

  // Get tasks for a specific member
  const getMemberTasks = (memberId: string) => {
    return tasks.filter((task) => task.assigneeId === memberId);
  };

  // Get member for a task
  const getMemberForTask = (task: Task) => {
    return teamMembers.find((m) => m.id === task.assigneeId) || null;
  };

  // Get comments for the selected task
  const getTaskComments = (taskId: string) => {
    return comments.filter(comment => comment.taskId === taskId);
  };

  // Handle sending a comment
  const handleSendComment = () => {
    if (!commentInput.trim() || !selectedTask) return;

    const member = getMemberForTask(selectedTask);
    const newComment: TaskComment = {
      id: `comment-${Date.now()}`,
      author: {
        name: member?.name || 'User',
        initials: member?.name.slice(0, 2) || 'U',
        color: '#8b5cf6',
      },
      content: commentInput,
      createdAt: new Date(),
      taskId: selectedTask.id,
    };

    setComments(prev => [...prev, newComment]);
    setCommentInput('');
  };

  // Show error state
  if (error) {
    return (
      <div className="flex flex-col flex-1 items-center justify-center">
        <AlertCircle className="h-12 w-12 text-red-400 mb-4" />
        <p className="text-lg font-medium text-gray-900 dark:text-foreground">Failed to load workload data</p>
        <p className="text-sm text-gray-500 mt-1">{error}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 pt-[10px] pb-[10px] border-b bg-background">
        <div className="flex items-center gap-2">
          {/* Filter Pills */}
          <FilterPills
            filters={activeFilters}
            filterConfigs={filterConfigs}
            maxFilters={5}
            onFiltersChange={setActiveFilters}
          />

          {/* View Mode Select */}
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className="h-8 w-[100px] justify-between shadow-none text-sm text-muted-foreground">
                {{ daily: 'Day', weekly: 'Week', monthly: 'Month', quarterly: 'Quarter' }[viewMode]}
                <ChevronDown className="h-3.5 w-3.5 opacity-50" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-[100px] p-1">
              {([['daily', 'Day'], ['weekly', 'Week'], ['monthly', 'Month'], ['quarterly', 'Quarter']] as const).map(([value, label]) => (
                <Button
                  key={value}
                  variant="ghost"
                  onClick={() => setViewMode(value)}
                  className="flex items-center justify-between w-full px-2 py-1.5 text-sm text-left hover:bg-muted rounded h-auto"
                >
                  <span>{label}</span>
                  {viewMode === value && <Check className="h-3.5 w-3.5" />}
                </Button>
              ))}
            </PopoverContent>
          </Popover>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => setZoom((z) => Math.max(50, z - 25))}
            disabled={zoom <= 50}
          >
            <MinusIcon className="h-4 w-4" />
          </Button>
          <span className="text-xs text-muted-foreground w-12 text-center">{zoom}%</span>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => setZoom((z) => Math.min(200, z + 25))}
            disabled={zoom >= 200}
          >
            <PlusIcon className="h-4 w-4" />
          </Button>
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
                  placeholder={st('sweep.weldflow.workloadView.searchMembersPlaceholder')}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onBlur={() => !searchQuery && setSearchOpen(false)}
                  className="h-8 w-full pl-8 pr-3 text-sm border border-border rounded-md bg-background focus:outline-none"
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      <GanttProvider
        className="border-r border-b flex-1 min-h-0"
        range={range}
        zoom={effectiveZoom}
      >
        <GanttSidebar sidebarLabel={st('sweep.weldflow.workloadView.members')} sidebarSecondaryLabel={st('sweep.weldflow.workloadView.availability')}>
          <div className="flex flex-col">
            {teamMembers.length === 0 && (
              <div className="flex flex-col items-center justify-center p-4 text-center h-32">
                <p className="text-xs text-muted-foreground">{st('sweep.weldflow.workloadView.noTeamMembers')}</p>
              </div>
            )}
            {teamMembers.map((member) => {
              const isExpanded = expandedMembers.has(member.id);
              const memberTasks = getMemberTasks(member.id);

              return (
                <div key={member.id}>
                  <TeamMemberSidebarItem
                    member={member}
                    tasks={tasks}
                    rowHeight={ROW_HEIGHT}
                    isExpanded={isExpanded}
                    onToggle={() => toggleMember(member.id)}
                  />
                  {/* Task rows when expanded */}
                  {isExpanded && memberTasks.length > 0 && memberTasks.map((task) => (
                    <TaskSidebarItem
                      key={task.id}
                      task={task}
                      rowHeight={TASK_ROW_HEIGHT}
                      isSelected={selectedTask?.id === task.id}
                      onClick={() => setSelectedTask(task)}
                    />
                  ))}
                  {isExpanded && memberTasks.length === 0 && (
                    <div
                      className="flex items-center pl-6 text-sm text-muted-foreground"
                      style={{ height: TASK_ROW_HEIGHT }}
                    >
                      {st('sweep.weldflow.workloadView.noTasksAssigned')}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </GanttSidebar>
        <GanttTimeline>
          <GanttHeader />
          <div
            className="absolute top-0 left-0 w-full"
            style={{ marginTop: 'var(--gantt-header-height)' }}
          >
            {teamMembers.map((member) => {
              const isExpanded = expandedMembers.has(member.id);
              const memberTasks = getMemberTasks(member.id);
              const avgWorkload = calculateDailyWorkload(member.id, tasks, new Date()).totalHours;

              return (
                <div key={member.id}>
                  {/* Mobile team member header - only visible on mobile */}
                  <div
                    className="md:hidden flex items-center gap-2 px-3 py-2 bg-background border-b border-border cursor-pointer sticky left-0 z-20"
                    style={{ width: '100vw', maxWidth: '100vw' }}
                    onClick={() => toggleMember(member.id)}
                  >
                    <Button variant="ghost" className="h-5 w-5 flex items-center justify-center text-muted-foreground p-0">
                      {isExpanded ? (
                        <ChevronDown className="h-3.5 w-3.5" />
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5" />
                      )}
                    </Button>
                    <Avatar className="h-6 w-6 rounded-md">
                      {member.image && <AvatarImage src={member.image} className="rounded-md" />}
                      <AvatarFallback className="rounded-md text-[10px]">{member.name.slice(0, 2)}</AvatarFallback>
                    </Avatar>
                    <span className="text-sm font-medium flex-1 truncate">{member.name}</span>
                    <span className={cn(
                      "text-xs font-medium",
                      avgWorkload > member.hoursPerDay ? "text-red-500" : avgWorkload > member.hoursPerDay * 0.8 ? "text-green-500" : "text-muted-foreground"
                    )}>
                      {avgWorkload.toFixed(1)}h / {member.hoursPerDay}h
                    </span>
                  </div>
                  {/* Workload area chart row */}
                  <div
                    className="relative border-b border-border"
                    style={{ height: ROW_HEIGHT }}
                  >
                    <WorkloadAreaChart
                      member={member}
                      tasks={tasks}
                      rowHeight={ROW_HEIGHT}
                    />
                  </div>
                  {/* Task rows when expanded */}
                  {isExpanded && memberTasks.length > 0 && memberTasks.map((task) => (
                    <TaskTimelineRow
                      key={task.id}
                      task={task}
                      rowHeight={TASK_ROW_HEIGHT}
                    />
                  ))}
                  {isExpanded && memberTasks.length === 0 && (
                    <div style={{ height: TASK_ROW_HEIGHT }} />
                  )}
                </div>
              );
            })}
          </div>
          {markers.map((marker) => (
            <GanttMarker
              key={marker.id}
              {...marker}
              onRemove={handleRemoveMarker}
              onRename={handleRenameMarker}
              onSelect={handleViewMarker}
            />
          ))}
          <GanttToday />
          {projectId && <GanttCreateMarkerTrigger onCreateMarker={handleCreateMarker} />}
        </GanttTimeline>
      </GanttProvider>

      {/* Milestone rename dialog */}
      <Dialog open={renameMarkerDialogOpen} onOpenChange={setRenameMarkerDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{st('sweep.weldflow.workloadView.renameMilestone')}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="marker-name">{st('sweep.weldflow.whiteboardListPage.name')}</Label>
              <Input
                id="marker-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSaveMarkerRename();
                }}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameMarkerDialogOpen(false)}>{st('sweep.weldflow.cancel')}</Button>
            <Button onClick={handleSaveMarkerRename}>{st('sweep.weldflow.workloadView.save')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Milestone popover */}
      <Popover open={viewMarkerPopoverOpen} onOpenChange={(open) => {
        if (!open) {
          setViewMarkerPopoverOpen(false);
          setSelectedMarker(null);
          setMarkerPopoverPosition(null);
          setMarkerDatePickerOpen(false);
        }
      }}>
        <PopoverTrigger asChild>
          <div
            className="fixed pointer-events-none"
            style={{
              left: markerPopoverPosition?.x ?? 0,
              top: markerPopoverPosition?.y ?? 0,
              width: 1,
              height: 1,
            }}
          />
        </PopoverTrigger>
        <PopoverContent className={cn("p-1", markerDatePickerOpen ? "w-auto" : "w-52")} align="start" sideOffset={5}>
          {selectedMarker && (
            <>
              {markerDatePickerOpen ? (
                <div>
                  <div className="px-2 py-1.5 flex items-center gap-2">
                    <Button
                      variant="ghost"
                      className="text-muted-foreground hover:text-foreground transition-colors p-0 h-auto w-auto"
                      onClick={() => setMarkerDatePickerOpen(false)}
                    >
                      <ChevronDown className="h-4 w-4 rotate-90" />
                    </Button>
                    <p className="text-sm font-medium">Change date & time</p>
                  </div>
                  <Separator className="my-1" />
                  <CalendarPicker
                    mode="single"
                    selected={selectedMarker.date}
                    onSelect={(date) => {
                      if (date) {
                        const prev = selectedMarker.date;
                        date.setHours(prev.getHours(), prev.getMinutes());
                        handleChangeMarkerDate(selectedMarker.id, date);
                      }
                    }}
                    initialFocus
                  />
                  <Separator />
                  <div className="px-3 py-2 flex items-center justify-center gap-1.5">
                    <Select
                      value={selectedMarker.date.getHours().toString().padStart(2, '0')}
                      onValueChange={(h) => {
                        const newDate = new Date(selectedMarker.date);
                        newDate.setHours(parseInt(h));
                        handleChangeMarkerDate(selectedMarker.id, newDate);
                      }}
                    >
                      <SelectTrigger className="w-24 h-8 text-sm"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {Array.from({ length: 24 }, (_, i) => i.toString().padStart(2, '0')).map((h) => (
                          <SelectItem key={h} value={h}>{h}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <span className="text-sm text-muted-foreground font-medium">:</span>
                    <Select
                      value={selectedMarker.date.getMinutes().toString().padStart(2, '0')}
                      onValueChange={(m) => {
                        const newDate = new Date(selectedMarker.date);
                        newDate.setMinutes(parseInt(m));
                        handleChangeMarkerDate(selectedMarker.id, newDate);
                      }}
                    >
                      <SelectTrigger className="w-24 h-8 text-sm"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {Array.from({ length: 60 }, (_, i) => i.toString().padStart(2, '0')).map((m) => (
                          <SelectItem key={m} value={m}>{m}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              ) : (
                <>
                  <div className="px-2 py-1.5">
                    <p className="text-sm font-medium leading-none truncate">{selectedMarker.label}</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {selectedMarker.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                      {(selectedMarker.date.getHours() !== 0 || selectedMarker.date.getMinutes() !== 0) && (
                        <span> at {selectedMarker.date.getHours().toString().padStart(2, '0')}:{selectedMarker.date.getMinutes().toString().padStart(2, '0')}</span>
                      )}
                    </p>
                  </div>
                  <Separator className="my-1" />
                  <div className="px-2 py-1.5">
                    <p className="text-xs font-medium text-muted-foreground mb-1.5">Color</p>
                    <div className="grid grid-cols-8 gap-1">
                      {markerColors.map((colorOption) => (
                        <Button
                          key={colorOption.name}
                          variant="ghost"
                          className={cn(
                            "h-5 w-5 rounded-[4px] flex items-center justify-center transition-shadow p-0",
                            selectedMarker.className === colorOption.className
                              ? 'ring-2 ring-ring ring-offset-1 ring-offset-background'
                              : 'hover:ring-1 hover:ring-ring/40 hover:ring-offset-1 hover:ring-offset-background'
                          )}
                          style={{ backgroundColor: colorOption.color }}
                          onClick={() => handleChangeMarkerColor(selectedMarker.id, colorOption.className)}
                          title={colorOption.name}
                        >
                          {selectedMarker.className === colorOption.className && (
                            <Check className="h-3 w-3 text-foreground/60" />
                          )}
                        </Button>
                      ))}
                    </div>
                  </div>
                  <Separator className="my-1" />
                  <div
                    role="menuitem"
                    className="relative flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground transition-colors"
                    onClick={() => setMarkerDatePickerOpen(true)}
                  >
                    <CalendarIcon className="h-4 w-4" />
                    {st('sweep.weldflow.workloadView.changeDate')}
                  </div>
                  <div
                    role="menuitem"
                    className="relative flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground transition-colors"
                    onClick={() => {
                      setViewMarkerPopoverOpen(false);
                      setMarkerPopoverPosition(null);
                      handleRenameMarker(selectedMarker.id);
                    }}
                  >
                    <SquarePen className="h-4 w-4" />
                    {st('sweep.weldflow.workloadView.rename')}
                  </div>
                  <div
                    role="menuitem"
                    className="relative flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none text-destructive hover:bg-destructive/10 hover:text-destructive transition-colors"
                    onClick={() => {
                      handleRemoveMarker(selectedMarker.id);
                      setViewMarkerPopoverOpen(false);
                      setSelectedMarker(null);
                      setMarkerPopoverPosition(null);
                    }}
                  >
                    <Trash2 className="h-4 w-4" />
                    {st('sweep.weldflow.delete')}
                  </div>
                </>
              )}
            </>
          )}
        </PopoverContent>
      </Popover>

      {/* Task Detail Panel */}
      <TaskDetailPanel
        task={selectedTask}
        member={selectedTask ? getMemberForTask(selectedTask) : null}
        onClose={() => setSelectedTask(null)}
        comments={selectedTask ? getTaskComments(selectedTask.id) : []}
        commentInput={commentInput}
        onCommentInputChange={setCommentInput}
        onSendComment={handleSendComment}
      />
    </div>
  );
}
