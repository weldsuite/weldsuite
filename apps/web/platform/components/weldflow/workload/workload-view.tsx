
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
import { Check, ChevronDown, ChevronRight, MinusIcon, PlusIcon, AlertCircle, Search, CalendarIcon, SquarePen, Trash2, UserX } from 'lucide-react';
import { useState, useRef, useEffect, useMemo, useCallback, memo, type ReactNode } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import { FilterPills, type ActiveFilter, type FilterConfig } from '@/components/entity-list';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@weldsuite/ui/components/popover';
import { useObjectPanel } from '@/components/object-panel';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { cn } from '@/lib/utils';
import { formatTaskNumber } from '@/lib/task-number';
import { formatHoursDecimalAsHm } from '@/lib/format-hours';
import { TaskNumberBadge } from '@/components/weldflow/task-number-badge';
import { formatDistance,
  addDays,
  eachDayOfInterval,
  isSameDay,
} from 'date-fns';
import type { Projects } from "@/lib/api/types/apps/projects.types";
import { ganttApi, type GanttMilestone } from '@/app/weldflow/lib/api-client';
import { toast } from 'sonner';
import { Separator } from '@weldsuite/ui/components/separator';
import { Calendar as CalendarPicker } from '@weldsuite/ui/components/calendar';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { useTranslations } from '@weldsuite/i18n/client';
import { useDateLocale } from '@/lib/i18n/date-locale';
import { dailyLoad, loadCategory, spreadTaskLoad } from './workload-math';
import { useProjectPermissions } from '@/app/weldflow/contexts/project-permission-context';

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
  /** Workspace-wide sequential number, rendered as the bare number. */
  number?: number | null;
  name: string;
  assigneeId: string;
  /** False when the task has neither a start nor a due date: it carries no load. */
  scheduled: boolean;
  startAt: Date;
  endAt: Date;
  /** Hours the task adds to each working day of its range. */
  hoursPerDay: number;
  /** The range contains no working day (e.g. a Saturday-only task), so weekends count. */
  weekendOnly: boolean;
  color: string;
  projectName?: string;
}

// Color palette for tasks
const TASK_COLORS = [
  '#93c5fd', '#c4b5fd', '#5eead4', '#fdba74', '#fca5a5',
  '#86efac', '#fcd34d', '#f9a8d4', '#a5b4fc', '#67e8f9',
];

/** Assignee id of the synthetic "Unassigned" bucket; never a real user id. */
const UNASSIGNED_ID = '__unassigned__';

// Transform API data to internal format
function transformApiData(data: Projects.WorkloadOverview | null, defaultRole: string): { members: TeamMember[], tasks: Task[] } {
  if (!data?.teamMembers) {
    return { members: [], tasks: [] };
  }

  const members: TeamMember[] = data.teamMembers.map(member => ({
    id: member.userId,
    name: member.name,
    image: member.avatar,
    role: member.role || defaultRole,
    hoursPerDay: member.capacity ? member.capacity / 5 : 8, // Convert weekly capacity to daily (assuming 5-day week)
  }));

  const tasks: Task[] = [];
  let colorIndex = 0;

  data.teamMembers.forEach(member => {
    if (member.tasks) {
      member.tasks.forEach(task => {
        // Hours are spread over working days, uncapped; undated tasks carry no load.
        const load = spreadTaskLoad(task);

        tasks.push({
          id: task.id,
          number: task.number ?? null,
          name: task.title,
          assigneeId: member.userId,
          ...load,
          color: TASK_COLORS[colorIndex % TASK_COLORS.length],
          projectName: task.projectName,
        });
        colorIndex++;
      });
    }
  });

  // Open tasks nobody carries: listed in their own section, never counted as load.
  (data.unassigned?.tasks ?? []).forEach(task => {
    tasks.push({
      id: task.id,
      number: task.number ?? null,
      name: task.title,
      assigneeId: UNASSIGNED_ID,
      ...spreadTaskLoad(task),
      color: TASK_COLORS[colorIndex % TASK_COLORS.length],
      projectName: task.projectName,
    });
    colorIndex++;
  });

  return { members, tasks };
}

// Workload calculation utilities
type UtilizationStatus = 'overloaded' | 'near' | 'available' | 'empty';

function getUtilizationStatus(utilization: number): UtilizationStatus {
  if (utilization > 100) return 'overloaded';
  if (utilization >= 80) return 'near';
  if (utilization > 0) return 'available';
  return 'empty';
}

function workloadTextClass(avgWorkload: number, hoursPerDay: number): string {
  if (avgWorkload > hoursPerDay) return "text-red-500";
  if (avgWorkload > hoursPerDay * 0.8) return "text-green-500";
  return "text-muted-foreground";
}

const calculateDailyWorkload = (
  memberId: string,
  tasks: Task[],
  date: Date
): { totalHours: number; tasks: Task[] } => dailyLoad(memberId, tasks, date);

// Task sidebar item (Gantt style)
const TaskSidebarItem = memo(({
  task,
  rowHeight,
  isSelected,
  onClick,
}: Readonly<{
  task: Task;
  rowHeight: number;
  isSelected?: boolean;
  onClick?: () => void;
}>) => {
  const st = useTranslations();
  const { dateFnsLocale } = useDateLocale();
  const tempEndAt =
    task.endAt && isSameDay(task.startAt, task.endAt)
      ? addDays(task.endAt, 1)
      : task.endAt;
  let duration: string;
  if (!task.scheduled) {
    duration = st('projects.gantt.noDates');
  } else if (tempEndAt) {
    duration = formatDistance(task.startAt, tempEndAt, { locale: dateFnsLocale });
  } else {
    duration = st('sweep.weldflow.workloadView.durationSoFar', {
      duration: formatDistance(task.startAt, new Date(), { locale: dateFnsLocale }),
    });
  }

  return (
    <button
      type="button"
      className={cn(
        "flex w-full items-center gap-2.5 p-2.5 text-xs text-left hover:bg-secondary pl-6 cursor-pointer transition-colors",
        isSelected && "bg-secondary"
      )}
      style={{ height: rowHeight }}
      onClick={onClick}
    >
      <div
        className="shrink-0 rounded-full h-1.5 w-1.5"
        style={{ backgroundColor: task.color }}
      />
      {task.number != null && (
        <TaskNumberBadge number={task.number} className="flex-shrink-0" />
      )}
      <p className="flex-1 truncate text-left text-muted-foreground">
        {task.name}
      </p>
      <p className="text-muted-foreground">{duration}</p>
    </button>
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
}: Readonly<{
  member: TeamMember;
  tasks: Task[];
  rowHeight: number;
  isExpanded: boolean;
  onToggle: () => void;
}>) => {
  const st = useTranslations();
  const avgWorkload = useMemo(() => {
    const today = new Date();
    const workload = calculateDailyWorkload(member.id, tasks, today);
    return workload.totalHours;
  }, [member.id, tasks]);

  const memberTasks = useMemo(() => {
    return tasks.filter((task) => task.assigneeId === member.id);
  }, [tasks, member.id]);

  return (
    <button
      type="button"
      aria-expanded={isExpanded}
      className="w-full text-left border-b border-border/50 flex items-center gap-3 px-3 cursor-pointer hover:bg-secondary/50"
      style={{ height: rowHeight }}
      onClick={onToggle}
    >
      <span className="h-5 w-5 flex items-center justify-center text-muted-foreground rounded-[5px] hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
        {isExpanded ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" />
        )}
      </span>
      <Avatar className="h-[30px] w-[30px] rounded-lg -ml-1">
        {member.image && <AvatarImage src={member.image} className="rounded-lg" />}
        <AvatarFallback className="rounded-lg text-xs">{(member.name ?? '?').slice(0, 2)}</AvatarFallback>
      </Avatar>
      <span className="block flex-1 min-w-0 -space-y-px -ml-1">
        <span className="block text-sm font-medium truncate">{member.name}</span>
        <span className="block text-xs text-muted-foreground">{member.role}</span>
      </span>
      <span className="block text-right space-y-0.5">
        <span className={cn(
          "block text-xs font-medium",
          workloadTextClass(avgWorkload, member.hoursPerDay)
        )}>
          {formatHoursDecimalAsHm(avgWorkload)} / {member.hoursPerDay}h
        </span>
        <span className="block text-xs text-muted-foreground">
          {memberTasks.length === 1
            ? st('sweep.weldflow.workloadView.taskCountSingular')
            : st('sweep.weldflow.workloadView.taskCount', { count: memberTasks.length })}
        </span>
      </span>
    </button>
  );
});

TeamMemberSidebarItem.displayName = 'TeamMemberSidebarItem';

// Section header for open tasks nobody carries: no capacity, so no availability figure
const UnassignedSidebarItem = memo(({
  taskCount,
  rowHeight,
  isExpanded,
  onToggle,
}: Readonly<{
  taskCount: number;
  rowHeight: number;
  isExpanded: boolean;
  onToggle: () => void;
}>) => {
  const st = useTranslations();
  return (
    <button
      type="button"
      aria-expanded={isExpanded}
      className="w-full text-left border-b border-border/50 flex items-center gap-3 px-3 cursor-pointer hover:bg-secondary/50"
      style={{ height: rowHeight }}
      onClick={onToggle}
    >
      <span className="h-5 w-5 flex items-center justify-center text-muted-foreground rounded-[5px] hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
        {isExpanded ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" />
        )}
      </span>
      <span className="h-[30px] w-[30px] -ml-1 flex items-center justify-center rounded-lg border border-dashed border-border text-muted-foreground">
        <UserX className="h-4 w-4" />
      </span>
      <span className="block flex-1 min-w-0 -ml-1 text-sm font-medium truncate">
        {st('sweep.weldflow.workloadView.unassignedTasks')}
      </span>
      <span className="block text-xs text-muted-foreground">
        {taskCount === 1
          ? st('sweep.weldflow.workloadView.taskCountSingular')
          : st('sweep.weldflow.workloadView.taskCount', { count: taskCount })}
      </span>
    </button>
  );
});

UnassignedSidebarItem.displayName = 'UnassignedSidebarItem';

// Workload area chart component for a team member
const WorkloadAreaChart = memo(({
  member,
  tasks,
  rowHeight,
}: Readonly<{
  member: TeamMember;
  tasks: Task[];
  rowHeight: number;
}>) => {
  const st = useTranslations();
  const { formatWeekday } = useDateLocale();
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
        const status = getUtilizationStatus(hoveredWorkload.utilization);

        const statusLabel = {
          overloaded: st('sweep.weldflow.workloadView.tooltipOverloaded'),
          near: st('sweep.weldflow.workloadView.tooltipNearCapacity'),
          available: st('sweep.weldflow.workloadView.tooltipAvailable'),
          empty: st('sweep.weldflow.workloadView.tooltipNoLoad'),
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

        let capacityDelta: ReactNode = null;
        if (status === 'overloaded') {
          capacityDelta = (
            <span className="text-[11px] font-medium text-red-600 dark:text-red-400 tabular-nums">
              {st('sweep.weldflow.workloadView.tooltipOver', { hours: formatHoursDecimalAsHm(overHours) })}
            </span>
          );
        } else if (status === 'available' || status === 'near') {
          capacityDelta = (
            <span className="text-[11px] text-muted-foreground tabular-nums">
              {st('sweep.weldflow.workloadView.tooltipLeft', { hours: formatHoursDecimalAsHm(-overHours) })}
            </span>
          );
        }

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
                  {formatWeekday(hoveredDate)}
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
                    {formatHoursDecimalAsHm(hoveredWorkload.hours)}
                  </span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    / {member.hoursPerDay}h
                  </span>
                </div>
                {capacityDelta}
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
                      {hoveredWorkload.tasks.length === 1
                        ? st('sweep.weldflow.workloadView.taskCountSingular')
                        : st('sweep.weldflow.workloadView.taskCount', { count: hoveredWorkload.tasks.length })}
                    </span>
                    <span className="text-[11px] text-muted-foreground tabular-nums">
                      {st('sweep.weldflow.workloadView.tooltipTotal', { hours: formatHoursDecimalAsHm(totalTaskHours) })}
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
                          <div className="text-sm truncate leading-tight">
                            {task.number != null && (
                              <span className="font-mono text-muted-foreground mr-1">
                                {formatTaskNumber(task.number)}
                              </span>
                            )}
                            {task.name}
                          </div>
                        </div>
                        <span className="text-xs font-medium text-muted-foreground tabular-nums shrink-0">
                          {formatHoursDecimalAsHm(task.hoursPerDay)}
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <div className="flex items-center gap-2 text-muted-foreground py-1">
                  <div className="w-2.5 h-2.5 rounded-[3px] bg-muted" />
                  <span className="text-sm">{st('sweep.weldflow.workloadView.noTasksScheduled')}</span>
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
}: Readonly<{
  task: Task;
  rowHeight: number;
}>) => {
  const st = useTranslations();
  // Convert task to GanttFeature format
  const feature: GanttFeature = useMemo(() => ({
    id: task.id,
    name: task.name,
    startAt: task.startAt,
    endAt: task.endAt,
    status: {
      id: 'active',
      name: st('sweep.weldflow.workloadView.statusActive'),
      color: task.color,
    },
  }), [task, st]);

  return (
    <div
      className="relative w-full"
      style={{ height: rowHeight }}
    >
      <GanttFeatureItem {...feature}>
        <p className="flex-1 truncate text-xs">
          {task.number != null && (
            <span className="font-mono opacity-70 mr-1">{formatTaskNumber(task.number)}</span>
          )}
          {task.name}
        </p>
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
  originalMilestone?: unknown;
}

const milestoneStatusColors: Record<string, string> = {
  planned: 'bg-purple-100 text-purple-900',
  pending: 'bg-yellow-100 text-yellow-900',
  in_progress: 'bg-blue-100 text-blue-900',
  completed: 'bg-green-100 text-green-900',
  missed: 'bg-red-100 text-red-900',
  postponed: 'bg-orange-100 text-orange-900',
};

function mapMilestoneToMarker(milestone: GanttMilestone, untitledLabel: string): GanttMarkerType {
  const dueDate = milestone.dueDate ? new Date(milestone.dueDate) : new Date();
  const statusClass = (milestone.status && milestoneStatusColors[milestone.status]) || milestoneStatusColors.planned;
  return {
    id: milestone.id,
    date: dueDate,
    label: milestone.name || untitledLabel,
    className: statusClass,
    originalMilestone: milestone,
  };
}

export interface WorkloadViewProps {
  initialData: Projects.WorkloadOverview | null;
  error: string | null;
  projectId?: string;
}

export function WorkloadView({ initialData, error, projectId }: Readonly<WorkloadViewProps>) {
  const st = useTranslations();
  const { dateFnsLocale, formatMedium } = useDateLocale();
  const { canWrite } = useProjectPermissions();
  // Milestones only exist on the project-scoped page, and viewers can read them but not change them.
  const canEditMilestones = !!projectId && canWrite;
  // Transform API data to internal format
  const { members: teamMembers, tasks } = useMemo(
    () => transformApiData(initialData, st('sweep.weldflow.workloadView.defaultRole')),
    [initialData, st]
  );
  const [viewMode, setViewMode] = useState<'daily' | 'weekly' | 'monthly' | 'quarterly'>('monthly');
  const [zoom, setZoom] = useState(100);
  const [expandedMembers, setExpandedMembers] = useState<Set<string>>(new Set());
  const { open: openObjectPanel } = useObjectPanel();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
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
        setMarkers(result.data.map((m) => mapMilestoneToMarker(m, st('sweep.weldflow.workloadView.untitledMilestone'))));
      }
    } catch (err) {
      console.error('Failed to load milestones:', err);
    }
  }, [projectId, st]);

  useEffect(() => {
    loadMilestones();
  }, [loadMilestones]);

  // Milestone handlers
  const handleCreateMarker = useCallback(async (date: Date) => {
    if (!projectId || !canWrite) return;
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
      const created = result.data;
      setMarkers((prev) => prev.map((m) => (m.id === tempId ? mapMilestoneToMarker(created, st('sweep.weldflow.workloadView.untitledMilestone')) : m)));
      toast.success(st('sweep.weldflow.workloadView.milestoneCreated'));
    } else {
      setMarkers((prev) => prev.filter((m) => m.id !== tempId));
      toast.error(st('sweep.weldflow.workloadView.milestoneCreateFailed'));
    }
  }, [projectId, canWrite, st]);

  const handleRemoveMarker = useCallback(async (id: string) => {
    if (!projectId || !canWrite) return;
    setMarkers((prev) => prev.filter((m) => m.id !== id));
    const result = await ganttApi.deleteMilestone(projectId, id);
    if (result.success) {
      toast.success(st('sweep.weldflow.workloadView.milestoneDeleted'));
    } else {
      toast.error(st('sweep.weldflow.workloadView.milestoneDeleteFailed'));
      loadMilestones();
    }
  }, [projectId, canWrite, loadMilestones, st]);

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
    if (!canWrite) return;
    const marker = markers.find((m) => m.id === id);
    if (marker) {
      setSelectedMarker(marker);
      setNewName(marker.label);
      setRenameMarkerDialogOpen(true);
    }
  }, [canWrite, markers]);

  const handleSaveMarkerRename = useCallback(async () => {
    if (!projectId || !canWrite || !selectedMarker || !newName.trim()) return;
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
  }, [projectId, canWrite, selectedMarker, newName, st]);

  const handleChangeMarkerDate = useCallback(async (markerId: string, newDate: Date) => {
    if (!projectId || !canWrite) return;
    setMarkers((prev) => prev.map((m) => m.id === markerId ? { ...m, date: newDate } : m));
    setSelectedMarker((prev) => prev?.id === markerId ? { ...prev, date: newDate } : prev);

    const result = await ganttApi.updateMilestone(projectId, markerId, { dueDate: newDate.toISOString() });
    if (result.success) {
      toast.success(st('sweep.weldflow.workloadView.milestoneDateUpdated'));
    } else {
      toast.error(st('sweep.weldflow.workloadView.milestoneDateUpdateFailed'));
      loadMilestones();
    }
  }, [projectId, canWrite, loadMilestones, st]);

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

  const viewModeLabels = {
    daily: st('projects.gantt.viewDay'),
    weekly: st('projects.gantt.viewWeek'),
    monthly: st('projects.gantt.viewMonth'),
    quarterly: st('projects.gantt.viewQuarter'),
  };
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

  // Scheduled tasks drive the chart and the Gantt rows; undated ones are listed apart.
  const getScheduledTasks = (memberId: string) =>
    tasks.filter((task) => task.assigneeId === memberId && task.scheduled);
  const getUnscheduledTasks = (memberId: string) =>
    tasks.filter((task) => task.assigneeId === memberId && !task.scheduled);

  // The filter pills and the search box narrow the member list.
  const visibleMembers = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const today = new Date();
    return teamMembers.filter((member) => {
      if (query && !member.name.toLowerCase().includes(query) && !member.role.toLowerCase().includes(query)) {
        return false;
      }
      return activeFilters.every((filter) => {
        // A pill still waiting for its operator or value filters nothing yet.
        if (!filter.operator || !filter.value) return true;
        let actual: string;
        if (filter.field === 'role') {
          actual = member.role;
        } else if (filter.field === 'workload') {
          actual = loadCategory(calculateDailyWorkload(member.id, tasks, today).totalHours, member.hoursPerDay);
        } else {
          return true;
        }
        const matches = actual === filter.value;
        return filter.operator === 'is not' ? !matches : matches;
      });
    });
  }, [teamMembers, tasks, searchQuery, activeFilters]);

  // The "Unassigned" section lists open tasks nobody carries. Role and workload
  // pills describe people, so any complete pill hides it; the search box still
  // matches it by name.
  const unassignedScheduled = getScheduledTasks(UNASSIGNED_ID);
  const unassignedUnscheduled = getUnscheduledTasks(UNASSIGNED_ID);
  const unassignedTotal = unassignedScheduled.length + unassignedUnscheduled.length;
  const unassignedExpanded = expandedMembers.has(UNASSIGNED_ID);
  const unassignedLabel = st('sweep.weldflow.workloadView.unassignedTasks');
  const showUnassigned = (() => {
    if (unassignedTotal === 0) return false;
    if (activeFilters.some((filter) => filter.operator && filter.value)) return false;
    const query = searchQuery.trim().toLowerCase();
    return !query || unassignedLabel.toLowerCase().includes(query);
  })();

  // Open the real task in the shared task panel (live status, comments and activity).
  const openTask = (task: Task) => {
    setSelectedTaskId(task.id);
    openObjectPanel({ type: 'task', id: task.id });
  };

  // Show error state
  if (error) {
    return (
      <div className="flex flex-col flex-1 items-center justify-center">
        <AlertCircle className="h-12 w-12 text-red-400 mb-4" />
        <p className="text-lg font-medium text-gray-900 dark:text-foreground">{st('sweep.weldflow.workloadView.loadFailed')}</p>
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
                {viewModeLabels[viewMode]}
                <ChevronDown className="h-3.5 w-3.5 opacity-50" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-[100px] p-1">
              {(Object.entries(viewModeLabels) as [keyof typeof viewModeLabels, string][]).map(([value, label]) => (
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
                searchOpen ? "opacity-100 w-48" : "opacity-0 w-0 overflow-hidden pointer-events-none"
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
        locale={dateFnsLocale}
        labels={{
          today: st('projects.gantt.today'),
          week: st('projects.gantt.viewWeek'),
          soFar: (duration) => st('projects.gantt.durationSoFar', { duration }),
        }}
      >
        <GanttSidebar sidebarLabel={st('sweep.weldflow.workloadView.members')} sidebarSecondaryLabel={st('sweep.weldflow.workloadView.availability')}>
          <div className="flex flex-col">
            {teamMembers.length === 0 && unassignedTotal === 0 && (
              <div className="flex flex-col items-center justify-center p-4 text-center h-32">
                <p className="text-xs text-muted-foreground">{st('sweep.weldflow.workloadView.noTeamMembers')}</p>
              </div>
            )}
            {teamMembers.length > 0 && visibleMembers.length === 0 && !showUnassigned && (
              <div className="flex flex-col items-center justify-center p-4 text-center h-32">
                <p className="text-xs text-muted-foreground">{st('sweep.weldflow.workloadView.noMatchingMembers')}</p>
              </div>
            )}
            {visibleMembers.map((member) => {
              const isExpanded = expandedMembers.has(member.id);
              const memberTasks = getScheduledTasks(member.id);
              const unscheduledTasks = getUnscheduledTasks(member.id);

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
                  {isExpanded && memberTasks.map((task) => (
                    <TaskSidebarItem
                      key={task.id}
                      task={task}
                      rowHeight={TASK_ROW_HEIGHT}
                      isSelected={selectedTaskId === task.id}
                      onClick={() => openTask(task)}
                    />
                  ))}
                  {/* Tasks without dates carry no load: listed apart instead of inventing one */}
                  {isExpanded && unscheduledTasks.length > 0 && (
                    <>
                      <div
                        className="flex items-center pl-6 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
                        style={{ height: TASK_ROW_HEIGHT }}
                      >
                        {st('sweep.weldflow.workloadView.unscheduled', { count: unscheduledTasks.length })}
                      </div>
                      {unscheduledTasks.map((task) => (
                        <TaskSidebarItem
                          key={task.id}
                          task={task}
                          rowHeight={TASK_ROW_HEIGHT}
                          isSelected={selectedTaskId === task.id}
                          onClick={() => openTask(task)}
                        />
                      ))}
                    </>
                  )}
                  {isExpanded && memberTasks.length === 0 && unscheduledTasks.length === 0 && (
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
            {showUnassigned && (
              <div>
                <UnassignedSidebarItem
                  taskCount={unassignedTotal}
                  rowHeight={ROW_HEIGHT}
                  isExpanded={unassignedExpanded}
                  onToggle={() => toggleMember(UNASSIGNED_ID)}
                />
                {unassignedExpanded && unassignedScheduled.map((task) => (
                  <TaskSidebarItem
                    key={task.id}
                    task={task}
                    rowHeight={TASK_ROW_HEIGHT}
                    isSelected={selectedTaskId === task.id}
                    onClick={() => openTask(task)}
                  />
                ))}
                {unassignedExpanded && unassignedUnscheduled.length > 0 && (
                  <>
                    <div
                      className="flex items-center pl-6 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
                      style={{ height: TASK_ROW_HEIGHT }}
                    >
                      {st('sweep.weldflow.workloadView.unscheduled', { count: unassignedUnscheduled.length })}
                    </div>
                    {unassignedUnscheduled.map((task) => (
                      <TaskSidebarItem
                        key={task.id}
                        task={task}
                        rowHeight={TASK_ROW_HEIGHT}
                        isSelected={selectedTaskId === task.id}
                        onClick={() => openTask(task)}
                      />
                    ))}
                  </>
                )}
              </div>
            )}
          </div>
        </GanttSidebar>
        <GanttTimeline>
          <GanttHeader />
          <div
            className="absolute top-0 left-0 w-full"
            style={{ marginTop: 'var(--gantt-header-height)' }}
          >
            {visibleMembers.map((member) => {
              const isExpanded = expandedMembers.has(member.id);
              const memberTasks = getScheduledTasks(member.id);
              const unscheduledCount = getUnscheduledTasks(member.id).length;
              const avgWorkload = calculateDailyWorkload(member.id, tasks, new Date()).totalHours;

              return (
                <div key={member.id}>
                  {/* Mobile team member header - only visible on mobile */}
                  <button
                    type="button"
                    aria-expanded={isExpanded}
                    className="md:hidden flex items-center gap-2 px-3 py-2 bg-background border-b border-border cursor-pointer sticky left-0 z-20 text-left"
                    style={{ width: '100vw', maxWidth: '100vw' }}
                    onClick={() => toggleMember(member.id)}
                  >
                    <span className="h-5 w-5 flex items-center justify-center text-muted-foreground">
                      {isExpanded ? (
                        <ChevronDown className="h-3.5 w-3.5" />
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5" />
                      )}
                    </span>
                    <Avatar className="h-6 w-6 rounded-md">
                      {member.image && <AvatarImage src={member.image} className="rounded-md" />}
                      <AvatarFallback className="rounded-md text-[10px]">{member.name.slice(0, 2)}</AvatarFallback>
                    </Avatar>
                    <span className="text-sm font-medium flex-1 truncate">{member.name}</span>
                    <span className={cn(
                      "text-xs font-medium",
                      workloadTextClass(avgWorkload, member.hoursPerDay)
                    )}>
                      {formatHoursDecimalAsHm(avgWorkload)} / {member.hoursPerDay}h
                    </span>
                  </button>
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
                  {isExpanded && memberTasks.map((task) => (
                    <TaskTimelineRow
                      key={task.id}
                      task={task}
                      rowHeight={TASK_ROW_HEIGHT}
                    />
                  ))}
                  {/* Spacers keep the timeline rows aligned with the sidebar's Unscheduled section */}
                  {isExpanded && unscheduledCount > 0 && (
                    <div style={{ height: TASK_ROW_HEIGHT * (unscheduledCount + 1) }} />
                  )}
                  {isExpanded && memberTasks.length === 0 && unscheduledCount === 0 && (
                    <div style={{ height: TASK_ROW_HEIGHT }} />
                  )}
                </div>
              );
            })}
            {showUnassigned && (
              <div>
                {/* Mobile header - only visible on mobile */}
                <button
                  type="button"
                  aria-expanded={unassignedExpanded}
                  className="md:hidden flex items-center gap-2 px-3 py-2 bg-background border-b border-border cursor-pointer sticky left-0 z-20 text-left"
                  style={{ width: '100vw', maxWidth: '100vw' }}
                  onClick={() => toggleMember(UNASSIGNED_ID)}
                >
                  <span className="h-5 w-5 flex items-center justify-center text-muted-foreground">
                    {unassignedExpanded ? (
                      <ChevronDown className="h-3.5 w-3.5" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5" />
                    )}
                  </span>
                  <span className="text-sm font-medium flex-1 truncate">{unassignedLabel}</span>
                  <span className="text-xs text-muted-foreground">{unassignedTotal}</span>
                </button>
                {/* No capacity to chart: an empty row keeps the timeline aligned with the sidebar */}
                <div className="relative border-b border-border" style={{ height: ROW_HEIGHT }} />
                {unassignedExpanded && unassignedScheduled.map((task) => (
                  <TaskTimelineRow
                    key={task.id}
                    task={task}
                    rowHeight={TASK_ROW_HEIGHT}
                  />
                ))}
                {unassignedExpanded && unassignedUnscheduled.length > 0 && (
                  <div style={{ height: TASK_ROW_HEIGHT * (unassignedUnscheduled.length + 1) }} />
                )}
              </div>
            )}
          </div>
          {markers.map((marker) => (
            <GanttMarker
              key={marker.id}
              {...marker}
              onRemove={canEditMilestones ? handleRemoveMarker : undefined}
              onRename={canEditMilestones ? handleRenameMarker : undefined}
              onSelect={handleViewMarker}
            />
          ))}
          <GanttToday />
          {canEditMilestones && <GanttCreateMarkerTrigger onCreateMarker={handleCreateMarker} />}
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
                    <p className="text-sm font-medium">{st('sweep.weldflow.workloadView.changeDateTime')}</p>
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
                        newDate.setHours(Number.parseInt(h));
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
                        newDate.setMinutes(Number.parseInt(m));
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
                      {formatMedium(selectedMarker.date)}
                      {(selectedMarker.date.getHours() !== 0 || selectedMarker.date.getMinutes() !== 0) && (
                        <span> {st('projects.gantt.atTime', { time: `${selectedMarker.date.getHours().toString().padStart(2, '0')}:${selectedMarker.date.getMinutes().toString().padStart(2, '0')}` })}</span>
                      )}
                    </p>
                  </div>
                  {canEditMilestones && (
                    <>
                      <Separator className="my-1" />
                      <div
                        role="menuitem"
                        tabIndex={0}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); } }}
                        className="relative flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground transition-colors"
                        onClick={() => setMarkerDatePickerOpen(true)}
                      >
                        <CalendarIcon className="h-4 w-4" />
                        {st('sweep.weldflow.workloadView.changeDate')}
                      </div>
                      <div
                        role="menuitem"
                        tabIndex={0}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); } }}
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
                        tabIndex={0}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); } }}
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
            </>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}
