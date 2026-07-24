
import React, { useState, useRef, useEffect } from "react";
import "./timeline.css";
import { Button } from "@weldsuite/ui/components/button";
import { Input } from "@weldsuite/ui/components/input";
import {
  ChevronRight,
  ChevronDown,
  Plus,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Filter,
  Settings2,
  Download,
  Share2,
  Search,
  Star,
  CheckCircle2,
  Circle,
  AlertCircle,
  Clock,
  Layers,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuCheckboxItem,
} from "@weldsuite/ui/components/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@weldsuite/ui/components/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@weldsuite/ui/components/tooltip";
import { Badge } from "@weldsuite/ui/components/badge";
import { cn } from "@/lib/utils";
import { useTranslations } from "@weldsuite/i18n/client";

interface Task {
  id: string;
  name: string;
  startDate: Date;
  endDate: Date;
  progress: number;
  assignee?: string;
  assigneeAvatar?: string;
  priority?: "low" | "medium" | "high" | "critical";
  status: "todo" | "in_progress" | "completed" | "blocked";
  dependencies?: string[];
  parent?: string;
  subtasks?: Task[];
  color?: string;
  type?: "task" | "milestone" | "project";
}

const mockTasks: Task[] = [
  {
    id: "1",
    name: "Website Redesign",
    startDate: new Date("2024-01-01"),
    endDate: new Date("2024-03-15"),
    progress: 65,
    assignee: "John Smith",
    priority: "high",
    status: "in_progress",
    color: "#4573d2",
    type: "project",
    subtasks: [
      {
        id: "1.1",
        name: "Design Mockups",
        startDate: new Date("2024-01-01"),
        endDate: new Date("2024-01-20"),
        progress: 100,
        assignee: "Sarah Johnson",
        status: "completed",
        parent: "1",
      },
      {
        id: "1.2",
        name: "Frontend Development",
        startDate: new Date("2024-01-21"),
        endDate: new Date("2024-02-20"),
        progress: 75,
        assignee: "Mike Wilson",
        status: "in_progress",
        parent: "1",
        dependencies: ["1.1"],
      },
      {
        id: "1.3",
        name: "Backend Integration",
        startDate: new Date("2024-02-10"),
        endDate: new Date("2024-03-01"),
        progress: 40,
        assignee: "Emily Davis",
        status: "in_progress",
        parent: "1",
      },
      {
        id: "1.4",
        name: "Testing & QA",
        startDate: new Date("2024-03-02"),
        endDate: new Date("2024-03-15"),
        progress: 0,
        assignee: "Robert Chen",
        status: "todo",
        parent: "1",
        dependencies: ["1.2", "1.3"],
      },
    ],
  },
  {
    id: "2",
    name: "Mobile App Launch",
    startDate: new Date("2024-02-01"),
    endDate: new Date("2024-04-30"),
    progress: 30,
    assignee: "Lisa Anderson",
    priority: "critical",
    status: "in_progress",
    color: "#f06a6a",
    type: "project",
    subtasks: [
      {
        id: "2.1",
        name: "iOS Development",
        startDate: new Date("2024-02-01"),
        endDate: new Date("2024-03-15"),
        progress: 45,
        assignee: "David Martinez",
        status: "in_progress",
        parent: "2",
      },
      {
        id: "2.2",
        name: "Android Development",
        startDate: new Date("2024-02-01"),
        endDate: new Date("2024-03-20"),
        progress: 35,
        assignee: "Jennifer Brown",
        status: "in_progress",
        parent: "2",
      },
      {
        id: "2.3",
        name: "App Store Submission",
        startDate: new Date("2024-03-21"),
        endDate: new Date("2024-03-25"),
        progress: 0,
        assignee: "Thomas White",
        status: "todo",
        parent: "2",
        type: "milestone",
        dependencies: ["2.1", "2.2"],
      },
    ],
  },
  {
    id: "3",
    name: "Marketing Campaign",
    startDate: new Date("2024-01-15"),
    endDate: new Date("2024-02-28"),
    progress: 85,
    assignee: "Amanda Taylor",
    priority: "medium",
    status: "in_progress",
    color: "#4caf50",
  },
];

// Flatten tasks with their subtasks
const flattenTasks = (tasks: Task[]): Task[] => {
  const flattened: Task[] = [];
  tasks.forEach(task => {
    flattened.push(task);
    if (task.subtasks) {
      task.subtasks.forEach(subtask => {
        flattened.push(subtask);
      });
    }
  });
  return flattened;
};

export default function TimelinePage() {
  const st = useTranslations();
  const [flatTasks] = useState<Task[]>(flattenTasks(mockTasks));
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [expandedTasks, setExpandedTasks] = useState<Set<string>>(new Set(["1", "2"]));
  const [viewMode, setViewMode] = useState<"day" | "week" | "month" | "quarter">("month");
  const [zoomLevel, setZoomLevel] = useState(1);
  const [showWeekends, setShowWeekends] = useState(true);
  const [, setGroupBy] = useState<"none" | "assignee" | "priority" | "status">("none");
  const [searchQuery, setSearchQuery] = useState("");
  const [sidebarWidth, setSidebarWidth] = useState(400);
  
  const chartRef = useRef<HTMLDivElement>(null);
  const resizeRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  // Calculate timeline range
  const getTimelineRange = () => {
    const allDates = flatTasks.flatMap(task => [task.startDate, task.endDate]);
    const minDate = new Date(Math.min(...allDates.map(d => d.getTime())));
    const maxDate = new Date(Math.max(...allDates.map(d => d.getTime())));
    
    // Add padding
    minDate.setMonth(minDate.getMonth() - 1);
    maxDate.setMonth(maxDate.getMonth() + 1);
    
    return { minDate, maxDate };
  };

  const { minDate, maxDate } = getTimelineRange();
  
  // Generate timeline headers based on view mode
  const generateTimelineHeaders = () => {
    const headers = [];
    const current = new Date(minDate);
    
    while (current <= maxDate) {
      headers.push(new Date(current));
      
      switch (viewMode) {
        case "day":
          current.setDate(current.getDate() + 1);
          break;
        case "week":
          current.setDate(current.getDate() + 7);
          break;
        case "month":
          current.setMonth(current.getMonth() + 1);
          break;
        case "quarter":
          current.setMonth(current.getMonth() + 3);
          break;
      }
    }
    
    return headers;
  };

  const timelineHeaders = generateTimelineHeaders();
  
  // Calculate task position and width
  const calculateTaskPosition = (task: Task) => {
    const totalDays = (maxDate.getTime() - minDate.getTime()) / (1000 * 60 * 60 * 24);
    const startDays = (task.startDate.getTime() - minDate.getTime()) / (1000 * 60 * 60 * 24);
    const durationDays = (task.endDate.getTime() - task.startDate.getTime()) / (1000 * 60 * 60 * 24);
    
    const left = (startDays / totalDays) * 100;
    const width = (durationDays / totalDays) * 100;
    
    return { left: `${left}%`, width: `${width}%` };
  };

  // Handle task expansion
  const toggleTaskExpansion = (taskId: string) => {
    const newExpanded = new Set(expandedTasks);
    if (newExpanded.has(taskId)) {
      newExpanded.delete(taskId);
    } else {
      newExpanded.add(taskId);
    }
    setExpandedTasks(newExpanded);
  };

  // Filter visible tasks
  const visibleTasks = flatTasks.filter(task => {
    // Check if parent is expanded
    if (task.parent && !expandedTasks.has(task.parent)) {
      return false;
    }
    
    // Search filter
    if (searchQuery && !task.name.toLowerCase().includes(searchQuery.toLowerCase())) {
      return false;
    }
    
    return true;
  });

  // Handle sidebar resize
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;
      const newWidth = e.clientX;
      if (newWidth > 300 && newWidth < 600) {
        setSidebarWidth(newWidth);
      }
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    if (isDragging) {
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    }

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging]);

  // Calculate today's position
  const today = new Date();
  const todayPosition = () => {
    const totalDays = (maxDate.getTime() - minDate.getTime()) / (1000 * 60 * 60 * 24);
    const todayDays = (today.getTime() - minDate.getTime()) / (1000 * 60 * 60 * 24);
    return (todayDays / totalDays) * 100;
  };

  return (
    <div className="timeline-container">
      {/* Header */}
      <div className="timeline-header">
        <div className="flex items-center gap-4 flex-1">
          <h1 className="text-xl font-semibold">{st('sweep.weldflow.timeline.title')}</h1>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" className="h-8">
              <Star className="h-4 w-4 mr-1" />
              {st('sweep.weldflow.timeline.star')}
            </Button>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder={st('sweep.weldflow.timeline.searchTasksPlaceholder')}
              className="pl-9 w-[250px] h-8"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
          <Button size="sm" className="h-8">
            <Plus className="h-4 w-4 mr-1" />
            {st('sweep.weldflow.timeline.addTask')}
          </Button>
          <Button variant="outline" size="sm" className="h-8">
            <Share2 className="h-4 w-4 mr-1" />
            {st('sweep.weldflow.timeline.share')}
          </Button>
        </div>
      </div>

      {/* Toolbar */}
      <div className="timeline-toolbar">
        <div className="flex items-center gap-4">
          <Select value={viewMode} onValueChange={(value: "day" | "week" | "month" | "quarter") => setViewMode(value)}>
            <SelectTrigger className="h-7 w-[100px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="day">{st('sweep.weldflow.timeline.day')}</SelectItem>
              <SelectItem value="week">{st('sweep.weldflow.timeline.week')}</SelectItem>
              <SelectItem value="month">{st('sweep.weldflow.timeline.month')}</SelectItem>
              <SelectItem value="quarter">{st('sweep.weldflow.timeline.quarter')}</SelectItem>
            </SelectContent>
          </Select>

          <div className="zoom-controls">
            <Button
              variant="outline"
              size="icon"
              className="h-7 w-7"
              onClick={() => setZoomLevel(Math.max(0.5, zoomLevel - 0.1))}
            >
              <ZoomOut className="h-3 w-3" />
            </Button>
            <span className="text-xs px-2">{Math.round(zoomLevel * 100)}%</span>
            <Button
              variant="outline"
              size="icon"
              className="h-7 w-7"
              onClick={() => setZoomLevel(Math.min(2, zoomLevel + 0.1))}
            >
              <ZoomIn className="h-3 w-3" />
            </Button>
            <Button variant="outline" size="icon" className="h-7 w-7 ml-1">
              <Maximize2 className="h-3 w-3" />
            </Button>
          </div>

          <div className="h-5 w-px bg-border" />

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-7">
                <Layers className="h-3 w-3 mr-1" />
                {st('sweep.weldflow.timeline.group')}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onClick={() => setGroupBy("none")}>
                {st('sweep.weldflow.timeline.groupNone')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setGroupBy("assignee")}>
                {st('sweep.weldflow.timeline.groupByAssignee')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setGroupBy("priority")}>
                {st('sweep.weldflow.timeline.groupByPriority')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setGroupBy("status")}>
                {st('sweep.weldflow.timeline.groupByStatus')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-7">
                <Filter className="h-3 w-3 mr-1" />
                {st('sweep.weldflow.timeline.filter')}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-56">
              <DropdownMenuCheckboxItem checked={showWeekends} onCheckedChange={setShowWeekends}>
                {st('sweep.weldflow.timeline.showWeekends')}
              </DropdownMenuCheckboxItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem>
                <Circle className="h-3 w-3 mr-2" />
                {st('sweep.weldflow.timeline.allTasks')}
              </DropdownMenuItem>
              <DropdownMenuItem>
                <CheckCircle2 className="h-3 w-3 mr-2" />
                {st('sweep.weldflow.timeline.completedTasks')}
              </DropdownMenuItem>
              <DropdownMenuItem>
                <Clock className="h-3 w-3 mr-2" />
                {st('sweep.weldflow.timeline.overdueTasks')}
              </DropdownMenuItem>
              <DropdownMenuItem>
                <AlertCircle className="h-3 w-3 mr-2" />
                {st('sweep.weldflow.timeline.atRisk')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" className="h-7 w-7">
            <Settings2 className="h-3 w-3" />
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7">
            <Download className="h-3 w-3" />
          </Button>
        </div>
      </div>

      {/* Main Content */}
      <div className="timeline-main">
        {/* Task List Sidebar */}
        <div className="timeline-sidebar" style={{ width: sidebarWidth }}>
          <div className="border-b px-4 py-2 bg-gray-50">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">{st('sweep.weldflow.timeline.tasksHeading')}</span>
              <Button variant="ghost" size="icon" className="h-6 w-6">
                <Plus className="h-3 w-3" />
              </Button>
            </div>
          </div>
          <div className="overflow-y-auto">
            {visibleTasks.map((task) => {
              const isParent = task.subtasks && task.subtasks.length > 0;
              const isExpanded = expandedTasks.has(task.id);
              const indentLevel = task.parent ? 1 : 0;

              return (
                <div
                  key={task.id}
                  className={cn(
                    "task-list-item",
                    isParent && "parent",
                    selectedTask?.id === task.id && "selected"
                  )}
                  style={{ paddingLeft: `${16 + indentLevel * 24}px` }}
                  onClick={() => setSelectedTask(task)}
                >
                  {isParent && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="mr-2 p-0"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleTaskExpansion(task.id);
                      }}
                    >
                      {isExpanded ? (
                        <ChevronDown className="h-3 w-3" />
                      ) : (
                        <ChevronRight className="h-3 w-3" />
                      )}
                    </Button>
                  )}
                  <div 
                    className={cn(
                      "task-checkbox",
                      task.status === "completed" && "checked"
                    )}
                  />
                  <span className="task-name">{task.name}</span>
                  {task.assignee && (
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger>
                          <div className="task-assignee">
                            {task.assignee.charAt(0).toUpperCase()}
                          </div>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>{task.assignee}</p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  )}
                  {task.endDate && (
                    <span className="task-date">
                      {task.endDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          <div
            ref={resizeRef}
            className="resize-handle"
            onMouseDown={() => setIsDragging(true)}
            style={{
              position: 'absolute',
              top: 0,
              right: 0,
              width: '4px',
              height: '100%',
              cursor: 'ew-resize',
              background: 'transparent',
            }}
          />
        </div>

        {/* Timeline Chart */}
        <div className="timeline-chart" ref={chartRef}>
          <div className="timeline-grid" style={{ transform: `scaleX(${zoomLevel})` }}>
            {/* Month Headers */}
            <div className="timeline-months">
              {timelineHeaders.map((date, index) => (
                <div key={index} className="timeline-month" style={{ minWidth: `${120 * zoomLevel}px` }}>
                  {date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}
                </div>
              ))}
            </div>

            {/* Day Headers */}
            <div className="timeline-days">
              {(() => {
                const days = [];
                const current = new Date(minDate);
                while (current <= maxDate) {
                  const isWeekend = current.getDay() === 0 || current.getDay() === 6;
                  const isToday = current.toDateString() === today.toDateString();
                  
                  if (showWeekends || !isWeekend) {
                    days.push(
                      <div
                        key={current.getTime()}
                        className={cn(
                          "timeline-day",
                          isWeekend && "weekend",
                          isToday && "today"
                        )}
                        style={{ minWidth: `${30 * zoomLevel}px` }}
                      >
                        {current.getDate()}
                      </div>
                    );
                  }
                  current.setDate(current.getDate() + 1);
                }
                return days;
              })()}
            </div>

            {/* Task Rows */}
            <div className="timeline-rows">
              {visibleTasks.map((task) => {
                const position = calculateTaskPosition(task);
                const getTaskColor = () => {
                  if (task.color) return task.color;
                  if (task.status === "completed") return "#4caf50";
                  if (task.progress === 0) return "#9e9e9e";
                  if (task.priority === "critical") return "#f44336";
                  if (task.priority === "high") return "#ff9800";
                  return "#4573d2";
                };
                
                return (
                  <div key={task.id} className="timeline-row">
                    <div
                      className={cn(
                        "timeline-task",
                        task.type === "milestone" && "milestone",
                        task.status === "completed" && "completed"
                      )}
                      style={{
                        left: position.left,
                        width: task.type === "milestone" ? "32px" : position.width,
                        background: getTaskColor(),
                      }}
                      onClick={() => setSelectedTask(task)}
                    >
                      {task.type === "milestone" ? (
                        <span>{st('sweep.weldflow.timeline.milestoneAbbreviation')}</span>
                      ) : (
                        <>
                          <span className="truncate">{task.name}</span>
                          {task.progress > 0 && task.progress < 100 && (
                            <div
                              className="absolute bottom-0 left-0 h-1 bg-black/20"
                              style={{ width: `${task.progress}%` }}
                            />
                          )}
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
              
              {/* Today Line */}
              <div 
                className="timeline-today-line" 
                style={{ left: `${todayPosition()}%` }}
              />
            </div>

            {/* Grid Lines */}
            <div className="timeline-grid-lines">
              {(() => {
                const lines = [];
                const current = new Date(minDate);
                while (current <= maxDate) {
                  const isWeekStart = current.getDay() === 1;
                  const isMonthStart = current.getDate() === 1;
                  
                  const totalDays = (maxDate.getTime() - minDate.getTime()) / (1000 * 60 * 60 * 24);
                  const currentDays = (current.getTime() - minDate.getTime()) / (1000 * 60 * 60 * 24);
                  const position = (currentDays / totalDays) * 100;
                  
                  lines.push(
                    <div
                      key={current.getTime()}
                      className={cn(
                        "grid-line-vertical",
                        isWeekStart && "week",
                        isMonthStart && "month"
                      )}
                      style={{ left: `${position}%` }}
                    />
                  );
                  
                  current.setDate(current.getDate() + 1);
                }
                return lines;
              })()}
            </div>
          </div>
        </div>
      </div>

      {/* Task Details Panel (if needed) */}
      {selectedTask && (
        <div className="fixed right-0 top-0 h-full w-96 bg-white border-l shadow-xl z-50 p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">{selectedTask.name}</h2>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setSelectedTask(null)}
            >
              ×
            </Button>
          </div>
          <div className="space-y-4">
            <div>
              <label className="text-sm text-muted-foreground">{st('sweep.weldflow.timeline.assignee')}</label>
              <p>{selectedTask.assignee || st('sweep.weldflow.timeline.unassigned')}</p>
            </div>
            <div>
              <label className="text-sm text-muted-foreground">{st('sweep.weldflow.timeline.progress')}</label>
              <div className="flex items-center gap-2">
                <div className="flex-1 h-2 bg-gray-200 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-blue-500"
                    style={{ width: `${selectedTask.progress}%` }}
                  />
                </div>
                <span className="text-sm">{selectedTask.progress}%</span>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-sm text-muted-foreground">{st('sweep.weldflow.timeline.startDate')}</label>
                <p>{selectedTask.startDate.toLocaleDateString()}</p>
              </div>
              <div>
                <label className="text-sm text-muted-foreground">{st('sweep.weldflow.timeline.endDate')}</label>
                <p>{selectedTask.endDate.toLocaleDateString()}</p>
              </div>
            </div>
            <div>
              <label className="text-sm text-muted-foreground">{st('sweep.weldflow.timeline.status')}</label>
              <Badge variant={
                selectedTask.status === "completed" ? "default" :
                selectedTask.status === "in_progress" ? "secondary" :
                selectedTask.status === "blocked" ? "destructive" :
                "outline"
              }>
                {selectedTask.status.replace('_', ' ')}
              </Badge>
            </div>
            {selectedTask.priority && (
              <div>
                <label className="text-sm text-muted-foreground">{st('sweep.weldflow.timeline.priority')}</label>
                <Badge variant={
                  selectedTask.priority === "critical" ? "destructive" :
                  selectedTask.priority === "high" ? "destructive" :
                  selectedTask.priority === "medium" ? "secondary" :
                  "outline"
                }>
                  {selectedTask.priority}
                </Badge>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}