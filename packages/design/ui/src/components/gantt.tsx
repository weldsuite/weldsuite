'use client';

import {
  DndContext,
  type DragMoveEvent,
  MouseSensor,
  useDraggable,
  useSensor,
} from '@dnd-kit/core';
import { restrictToHorizontalAxis } from '@dnd-kit/modifiers';
import { useMouse, useThrottle, useWindowScroll } from '@uidotdev/usehooks';
import {
  addDays,
  addWeeks,
  differenceInDays,
  format,
  formatDate,
  formatDistance,
  getDaysInMonth,
  isSameDay,
  type Locale,
  startOfDay,
  startOfWeek,
} from 'date-fns';
import { atom, useAtom } from 'jotai';
import throttle from 'lodash.throttle';
import { PencilIcon, PlusIcon, TrashIcon } from 'lucide-react';
import type {
  CSSProperties,
  FC,
  MouseEventHandler,
  ReactNode,
  RefObject,
} from 'react';
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from './context-menu';
import { cn } from '../lib/utils';
import {
  getAddRange,
  getDateAtOffset,
  getDifferenceIn,
  getDragShiftDays,
  getEndOf,
  getInnerDifferenceIn,
  getOffset,
  getStartOf,
  getWidth,
  getsDaysIn,
} from '../lib/gantt-math';

const SIDEBAR_WIDTH = 380;

const draggingAtom = atom(false);
const scrollXAtom = atom(0);

export const useGanttDragging = () => useAtom(draggingAtom);
export const useGanttScrollX = () => useAtom(scrollXAtom);

export type GanttStatus = {
  id: string;
  name: string;
  color: string;
};

export type GanttFeature = {
  id: string;
  name: string;
  startAt: Date;
  endAt: Date;
  status: GanttStatus;
  lane?: string; // Optional: features with the same lane will share a row
  parentTaskId?: string;
  isSubtask?: boolean;
  /** No dates yet: rendered as a ghost bar that is scheduled by dragging it. */
  unscheduled?: boolean;
};

export type GanttMarkerProps = {
  id: string;
  date: Date;
  label: string;
};

export type Range = 'daily' | 'weekly' | 'monthly' | 'quarterly';

export type TimelineData = {
  year: number;
  quarters: {
    months: {
      days: number;
    }[];
  }[];
}[];

/** Strings the chart renders itself, for hosts that translate. English when omitted. */
export type GanttLabels = {
  /** "Today" flag on the current-day line. */
  today?: string;
  /** "Week" prefix in the weekly header. */
  week?: string;
  /** Duration suffix for open-ended items. Receives the formatted distance. */
  soFar?: (duration: string) => string;
};

export type GanttContextProps = {
  /** date-fns locale for month, weekday and date labels. English when omitted. */
  locale?: Locale;
  labels?: GanttLabels;
  zoom: number;
  range: Range;
  columnWidth: number;
  sidebarWidth: number;
  headerHeight: number;
  rowHeight: number;
  onAddItem: ((date: Date) => void) | undefined;
  placeholderLength: number;
  timelineData: TimelineData;
  ref: RefObject<HTMLDivElement | null> | null;
  scrollToFeature?: (feature: GanttFeature) => void;
};

const getDateByMousePosition = (context: GanttContextProps, mouseX: number) => {
  const timelineStartDate = new Date(context.timelineData.at(0)?.year ?? 0, 0, 1);
  const columnWidth = (context.columnWidth * context.zoom) / 100;
  const offset = Math.floor(mouseX / columnWidth);
  const daysIn = getsDaysIn(context.range);
  const addRange = getAddRange(context.range);
  const month = addRange(timelineStartDate, offset);
  const daysInMonth = daysIn(month);
  const pixelsPerDay = Math.round(columnWidth / daysInMonth);
  const dayOffset = Math.floor((mouseX % columnWidth) / pixelsPerDay);
  const actualDate = addDays(month, dayOffset);

  return actualDate;
};

const createInitialTimelineData = (today: Date) => {
  const data: TimelineData = [];

  data.push(
    { year: today.getFullYear() - 1, quarters: new Array(4).fill(null) },
    { year: today.getFullYear(), quarters: new Array(4).fill(null) },
    { year: today.getFullYear() + 1, quarters: new Array(4).fill(null) }
  );

  for (const yearObj of data) {
    yearObj.quarters = new Array(4).fill(null).map((_, quarterIndex) => ({
      months: new Array(3).fill(null).map((_, monthIndex) => {
        const month = quarterIndex * 3 + monthIndex;
        return {
          days: getDaysInMonth(new Date(yearObj.year, month, 1)),
        };
      }),
    }));
  }

  return data;
};

const calculateInnerOffset = (
  date: Date,
  range: Range,
  columnWidth: number
) => {
  const startOf = getStartOf(range);
  const endOf = getEndOf(range);
  const differenceIn = getInnerDifferenceIn(range);
  const startOfRange = startOf(date);
  const endOfRange = endOf(date);
  const totalRangeDays = differenceIn(endOfRange, startOfRange);
  const dayOfMonth = date.getDate();

  return (dayOfMonth / totalRangeDays) * columnWidth;
};

const GanttContext = createContext<GanttContextProps>({
  zoom: 100,
  range: 'monthly',
  columnWidth: 50,
  headerHeight: 60,
  sidebarWidth: 380,
  rowHeight: 36,
  onAddItem: undefined,
  placeholderLength: 2,
  timelineData: [],
  ref: null,
  scrollToFeature: undefined,
});

export const useGantt = () => useContext(GanttContext);

export type GanttContentHeaderProps = {
  renderHeaderItem: (index: number) => ReactNode;
  title: string;
  columns: number;
};

export const GanttContentHeader: FC<GanttContentHeaderProps> = ({
  title,
  columns,
  renderHeaderItem,
}) => {
  const id = useId();

  return (
    <div
      className="sticky top-0 z-20 grid w-full shrink-0 bg-background/90 backdrop-blur-sm"
      style={{ height: 'var(--gantt-header-height)' }}
    >
      <div>
        <div
          className="sticky inline-flex whitespace-nowrap px-3 py-2 text-muted-foreground text-xs"
          style={{
            left: 'var(--gantt-sidebar-width)',
          }}
        >
          <p>{title}</p>
        </div>
      </div>
      <div
        className="grid w-full"
        style={{
          gridTemplateColumns: `repeat(${columns}, var(--gantt-column-width))`,
        }}
      >
        {Array.from({ length: columns }).map((_, index) => (
          <div
            className="shrink-0 border-border/50 border-b py-1 text-center text-xs"
            key={`${id}-${index}`}
          >
            {renderHeaderItem(index)}
          </div>
        ))}
      </div>
    </div>
  );
};

const DailyHeader: FC = () => {
  const gantt = useContext(GanttContext);

  return gantt.timelineData.map((year) =>
    year.quarters
      .flatMap((quarter) => quarter.months)
      .map((month, index) => (
        <div className="relative flex flex-col" key={`${year.year}-${index}`}>
          <GanttContentHeader
            columns={month.days}
            renderHeaderItem={(item: number) => (
              <div className="flex items-center justify-center gap-1">
                <p>
                  {format(addDays(new Date(year.year, index, 1), item), 'd', {
                    locale: gantt.locale,
                  })}
                </p>
                <p className="text-muted-foreground">
                  {format(
                    addDays(new Date(year.year, index, 1), item),
                    'EEEEE',
                    { locale: gantt.locale }
                  )}
                </p>
              </div>
            )}
            title={format(new Date(year.year, index, 1), 'MMMM yyyy', {
              locale: gantt.locale,
            })}
          />
          <GanttColumns
            columns={month.days}
            isColumnSecondary={(item: number) =>
              [0, 6].includes(
                addDays(new Date(year.year, index, 1), item).getDay()
              )
            }
          />
        </div>
      ))
  );
};

const MonthlyHeader: FC = () => {
  const gantt = useContext(GanttContext);

  return gantt.timelineData.map((year) => (
    <div className="relative flex flex-col h-full" key={year.year}>
      <GanttContentHeader
        columns={year.quarters.flatMap((quarter) => quarter.months).length}
        renderHeaderItem={(item: number) => (
          <p>{format(new Date(year.year, item, 1), 'MMM', { locale: gantt.locale })}</p>
        )}
        title={`${year.year}`}
      />
      <GanttColumns
        columns={year.quarters.flatMap((quarter) => quarter.months).length}
      />
    </div>
  ));
};

const QuarterlyHeader: FC = () => {
  const gantt = useContext(GanttContext);

  return gantt.timelineData.map((year) =>
    year.quarters.map((quarter, quarterIndex) => (
      <div
        className="relative flex flex-col"
        key={`${year.year}-${quarterIndex}`}
      >
        <GanttContentHeader
          columns={quarter.months.length}
          renderHeaderItem={(item: number) => (
            <p>
              {format(new Date(year.year, quarterIndex * 3 + item, 1), 'MMM', {
                locale: gantt.locale,
              })}
            </p>
          )}
          title={`Q${quarterIndex + 1} ${year.year}`}
        />
        <GanttColumns columns={quarter.months.length} />
      </div>
    ))
  );
};

const WeeklyHeader: FC = () => {
  const gantt = useContext(GanttContext);
  const startDate = useMemo(
    () =>
      startOfWeek(new Date(gantt.timelineData.at(0)?.year ?? 0, 0, 1), {
        weekStartsOn: 1,
      }),
    [gantt.timelineData]
  );
  const lastYear = gantt.timelineData.at(-1)?.year ?? 0;
  const endDate = useMemo(() => new Date(lastYear, 11, 31), [lastYear]);
  const totalWeeks = Math.ceil(differenceInDays(endDate, startDate) / 7) + 1;

  // Group week columns by the year they FALL IN (start day) so the title
  // row matches the existing year headers used by Daily/Monthly views.
  const groups = useMemo(() => {
    const out: { year: number; firstWeekIndex: number; weeks: number }[] = [];
    for (let i = 0; i < totalWeeks; i++) {
      const weekStart = addWeeks(startDate, i);
      const year = weekStart.getFullYear();
      const last = out.at(-1);
      if (last && last.year === year) {
        last.weeks += 1;
      } else {
        out.push({ year, firstWeekIndex: i, weeks: 1 });
      }
    }
    return out;
  }, [startDate, totalWeeks]);

  return groups.map((group) => (
    <div
      className="relative flex flex-col"
      key={`${group.year}-${group.firstWeekIndex}`}
    >
      <GanttContentHeader
        columns={group.weeks}
        renderHeaderItem={(item: number) => {
          const weekStart = addWeeks(startDate, group.firstWeekIndex + item);
          // ISO-style week-of-year (Mon-aligned), formatted "Week N".
          return (
            <p>
              {gantt.labels?.week ?? 'Week'} {format(weekStart, 'I')}
            </p>
          );
        }}
        title={`${group.year}`}
      />
      <GanttColumns columns={group.weeks} />
    </div>
  ));
};

const headers: Record<Range, FC> = {
  daily: DailyHeader,
  weekly: WeeklyHeader,
  monthly: MonthlyHeader,
  quarterly: QuarterlyHeader,
};

export type GanttHeaderProps = {
  className?: string;
};

export const GanttHeader: FC<GanttHeaderProps> = ({ className }) => {
  const gantt = useContext(GanttContext);
  const Header = headers[gantt.range];

  return (
    <div
      className={cn(
        '-space-x-px flex min-h-full w-max divide-x divide-border/50',
        className
      )}
    >
      <Header />
    </div>
  );
};

export type GanttSidebarItemProps = {
  feature: GanttFeature;
  onSelectItem?: (id: string) => void;
  className?: string;
  /** Shown instead of the duration for features without dates. */
  unscheduledLabel?: string;
};

export const GanttSidebarItem: FC<GanttSidebarItemProps> = ({
  feature,
  onSelectItem,
  className,
  unscheduledLabel,
}) => {
  const gantt = useContext(GanttContext);
  const tempEndAt =
    feature.endAt && isSameDay(feature.startAt, feature.endAt)
      ? addDays(feature.endAt, 1)
      : feature.endAt;
  const duration = feature.unscheduled
    ? (unscheduledLabel ?? 'No dates')
    : tempEndAt
      ? formatDistance(feature.startAt, tempEndAt, { locale: gantt.locale })
      : (gantt.labels?.soFar ?? ((distance: string) => `${distance} so far`))(
          formatDistance(feature.startAt, new Date(), { locale: gantt.locale })
        );

  const handleClick: MouseEventHandler<HTMLButtonElement> = (event) => {
    if (event.target === event.currentTarget) {
      // Scroll to the feature in the timeline
      gantt.scrollToFeature?.(feature);
      // Call the original onSelectItem callback
      onSelectItem?.(feature.id);
    }
  };

  return (
    <button
      type="button"
      className={cn(
        'relative flex w-full items-center gap-2.5 p-2.5 text-left text-xs hover:bg-secondary',
        feature.isSubtask && 'pl-6',
        className
      )}
      key={feature.id}
      onClick={handleClick}
      style={{
        height: 'var(--gantt-row-height)',
      }}
    >
      <div
        className={cn(
          'pointer-events-none shrink-0 rounded-full',
          feature.isSubtask ? 'h-1.5 w-1.5' : 'h-2 w-2'
        )}
        style={{
          backgroundColor: feature.status.color,
        }}
      />
      <p className={cn(
        'pointer-events-none flex-1 truncate text-left',
        feature.isSubtask ? 'text-muted-foreground' : 'font-medium'
      )}>
        {feature.name}
      </p>
      <p className="pointer-events-none text-muted-foreground">{duration}</p>
    </button>
  );
};

export type GanttSidebarHeaderProps = {
  onAddTask?: () => void;
  label?: string;
  secondaryLabel?: string;
};

export const GanttSidebarHeader: FC<GanttSidebarHeaderProps> = ({
  onAddTask,
  label = 'Issues',
  secondaryLabel = 'Duration',
}) => (
  <div
    className="sticky top-0 z-10 flex shrink-0 items-end justify-between gap-2.5 border-border/50 border-b bg-background/90 p-2.5 font-medium text-muted-foreground text-xs backdrop-blur-sm"
    style={{ height: 'var(--gantt-header-height)' }}
  >
    <p className="flex-1 truncate text-left">{label}</p>
    <div className="shrink-0 flex flex-col items-end gap-1">
      {onAddTask && (
        <button
          onClick={onAddTask}
          className="h-5 w-5 flex items-center justify-center rounded-[5px] hover:bg-secondary transition-colors mr-[-2px]"
          type="button"
        >
          <PlusIcon className="h-3.5 w-3.5" />
        </button>
      )}
      <p>{secondaryLabel}</p>
    </div>
  </div>
);

export type GanttSidebarGroupProps = {
  children: ReactNode;
  name: string;
  className?: string;
};

export const GanttSidebarGroup: FC<GanttSidebarGroupProps> = ({
  children,
  name,
  className,
}) => (
  <div className={className}>
    <p
      className="w-full truncate p-2.5 text-left font-medium text-muted-foreground text-xs"
      style={{ height: 'var(--gantt-row-height)' }}
    >
      {name}
    </p>
    <div className="divide-y divide-border/50">{children}</div>
  </div>
);

export type GanttSidebarProps = {
  children: ReactNode;
  className?: string;
  onAddTask?: () => void;
  sidebarLabel?: string;
  sidebarSecondaryLabel?: string;
};

export const GanttSidebar: FC<GanttSidebarProps> = ({
  children,
  className,
  onAddTask,
  sidebarLabel,
  sidebarSecondaryLabel,
}) => (
  <div
    className={cn(
      'sticky left-0 z-30 h-max min-h-full overflow-clip border-border/50 border-r bg-background/90 backdrop-blur-md',
      className
    )}
    data-roadmap-ui="gantt-sidebar"
  >
    <GanttSidebarHeader
      onAddTask={onAddTask}
      label={sidebarLabel}
      secondaryLabel={sidebarSecondaryLabel}
    />
    <div className="space-y-4">{children}</div>
  </div>
);

export type GanttAddFeatureHelperProps = {
  top: number;
  className?: string;
};

export const GanttAddFeatureHelper: FC<GanttAddFeatureHelperProps> = ({
  top,
  className,
}) => {
  const [scrollX] = useGanttScrollX();
  const gantt = useContext(GanttContext);
  const [mousePosition, mouseRef] = useMouse<HTMLDivElement>();

  const handleClick = () => {
    const ganttRect = gantt.ref?.current?.getBoundingClientRect();
    const x =
      mousePosition.x - (ganttRect?.left ?? 0) + scrollX - gantt.sidebarWidth;
    const currentDate = getDateByMousePosition(gantt, x);

    gantt.onAddItem?.(currentDate);
  };

  return (
    <div
      className={cn('absolute top-0 w-full px-0.5', className)}
      ref={mouseRef}
      style={{
        marginTop: -gantt.rowHeight / 2,
        transform: `translateY(${top}px)`,
      }}
    >
      <button
        className="flex h-full w-full items-center justify-center rounded-md border border-dashed p-2"
        onClick={handleClick}
        type="button"
      >
        <PlusIcon
          className="pointer-events-none select-none text-muted-foreground"
          size={16}
        />
      </button>
    </div>
  );
};

export type GanttColumnProps = {
  index: number;
  isColumnSecondary?: (item: number) => boolean;
};

export const GanttColumn: FC<GanttColumnProps> = ({
  index,
  isColumnSecondary,
}) => {
  const gantt = useContext(GanttContext);
  const [dragging] = useGanttDragging();
  const [mousePosition, mouseRef] = useMouse<HTMLDivElement>();
  const [hovering, setHovering] = useState(false);
  const [windowScroll] = useWindowScroll();

  const handleMouseEnter = () => setHovering(true);
  const handleMouseLeave = () => setHovering(false);

  const top = useThrottle(
    mousePosition.y -
      (mouseRef.current?.getBoundingClientRect().y ?? 0) -
      (windowScroll.y ?? 0),
    10
  );

  return (
    <div
      className={cn(
        'group relative h-full overflow-hidden',
        isColumnSecondary?.(index) ? 'bg-secondary' : ''
      )}
      onPointerEnter={handleMouseEnter}
      onPointerLeave={handleMouseLeave}
      ref={mouseRef}
    >
      {!dragging && hovering && gantt.onAddItem ? (
        <GanttAddFeatureHelper top={top} />
      ) : null}
    </div>
  );
};

export type GanttColumnsProps = {
  columns: number;
  isColumnSecondary?: (item: number) => boolean;
};

export const GanttColumns: FC<GanttColumnsProps> = ({
  columns,
  isColumnSecondary,
}) => {
  const id = useId();

  return (
    <div
      className="divide grid flex-1 min-h-0 w-full divide-x divide-border/50"
      style={{
        gridTemplateColumns: `repeat(${columns}, var(--gantt-column-width))`,
      }}
    >
      {Array.from({ length: columns }).map((_, index) => (
        <GanttColumn
          index={index}
          isColumnSecondary={isColumnSecondary}
          key={`${id}-${index}`}
        />
      ))}
    </div>
  );
};

export type GanttCreateMarkerTriggerProps = {
  onCreateMarker: (date: Date) => void;
  className?: string;
};

export const GanttCreateMarkerTrigger: FC<GanttCreateMarkerTriggerProps> = ({
  onCreateMarker,
  className,
}) => {
  const gantt = useContext(GanttContext);
  const [mousePosition, mouseRef] = useMouse<HTMLDivElement>();
  const [windowScroll] = useWindowScroll();
  const x = useThrottle(
    mousePosition.x -
      (mouseRef.current?.getBoundingClientRect().x ?? 0) -
      (windowScroll.x ?? 0),
    10
  );

  const date = getDateByMousePosition(gantt, x);

  const handleClick = () => onCreateMarker(date);

  return (
    <div
      className={cn(
        'group pointer-events-none absolute top-0 left-0 h-full w-full select-none overflow-visible',
        className
      )}
      ref={mouseRef}
    >
      <div
        className="-ml-2 pointer-events-auto sticky top-6 z-20 flex w-4 flex-col items-center justify-center gap-1 overflow-visible opacity-0 group-hover:opacity-100"
        style={{ transform: `translateX(${x}px)` }}
      >
        <button
          className="z-50 inline-flex h-4 w-4 items-center justify-center rounded-full bg-card"
          onClick={handleClick}
          type="button"
        >
          <PlusIcon className="text-muted-foreground" size={12} />
        </button>
        <div className="whitespace-nowrap rounded-full border border-border/50 bg-background/90 px-2 py-1 text-foreground text-xs backdrop-blur-lg">
          {formatDate(date, 'MMM dd, yyyy', { locale: gantt.locale })}
        </div>
      </div>
    </div>
  );
};

export type GanttFeatureDragHelperProps = {
  featureId: GanttFeature['id'];
  direction: 'left' | 'right';
  date: Date | null;
};

export const GanttFeatureDragHelper: FC<GanttFeatureDragHelperProps> = ({
  direction,
  featureId,
  date,
}) => {
  const gantt = useContext(GanttContext);
  const [, setDragging] = useGanttDragging();
  const { attributes, listeners, setNodeRef } = useDraggable({
    id: `feature-drag-helper-${featureId}`,
  });

  const isPressed = Boolean(attributes['aria-pressed']);

  useEffect(() => setDragging(isPressed), [isPressed, setDragging]);

  return (
    <div
      className={cn(
        'group -translate-y-1/2 !cursor-col-resize absolute top-1/2 z-[3] h-full w-6 rounded-md outline-none',
        direction === 'left' ? '-left-2.5' : '-right-2.5'
      )}
      ref={setNodeRef}
      {...attributes}
      {...listeners}
    >
      <div
        className={cn(
          '-translate-y-1/2 absolute top-1/2 h-[80%] w-1 rounded-sm bg-muted-foreground opacity-0 transition-all',
          direction === 'left' ? 'left-2.5' : 'right-2.5',
          direction === 'left' ? 'group-hover:left-0' : 'group-hover:right-0',
          isPressed && (direction === 'left' ? 'left-0' : 'right-0'),
          'group-hover:opacity-100',
          isPressed && 'opacity-100'
        )}
      />
      {date && (
        <div
          className={cn(
            '-translate-x-1/2 absolute top-10 hidden whitespace-nowrap rounded-lg border border-border/50 bg-background/90 px-2 py-1 text-foreground text-xs backdrop-blur-lg group-hover:block',
            isPressed && 'block'
          )}
        >
          {format(date, 'MMM dd, yyyy', { locale: gantt.locale })}
        </div>
      )}
    </div>
  );
};

export type GanttFeatureItemCardProps = Pick<GanttFeature, 'id'> & {
  children?: ReactNode;
  color?: string;
  unscheduled?: boolean;
};

export const GanttFeatureItemCard: FC<GanttFeatureItemCardProps> = ({
  id,
  children,
  color,
  unscheduled,
}) => {
  const [, setDragging] = useGanttDragging();
  const { attributes, listeners, setNodeRef } = useDraggable({ id });
  const isPressed = Boolean(attributes['aria-pressed']);

  useEffect(() => setDragging(isPressed), [isPressed, setDragging]);

  return (
    <div
      className={cn(
        'h-full w-full rounded-md px-2 py-1 text-xs',
        unscheduled && 'border border-dashed border-gray-500/60 opacity-60'
      )}
      style={{
        backgroundColor: color || '#e5e7eb',
      }}
    >
      <div
        className={cn(
          'flex h-full w-full items-center justify-between gap-2 text-left text-gray-800',
          isPressed && 'cursor-grabbing'
        )}
        {...attributes}
        {...listeners}
        ref={setNodeRef}
      >
        {children}
      </div>
    </div>
  );
};

export type GanttFeatureItemProps = GanttFeature & {
  onMove?: (id: string, startDate: Date, endDate: Date | null) => void;
  children?: ReactNode;
  className?: string;
};

export const GanttFeatureItem: FC<GanttFeatureItemProps> = ({
  onMove,
  children,
  className,
  ...feature
}) => {
  const gantt = useContext(GanttContext);
  const timelineStartDate = useMemo(
    () => new Date(gantt.timelineData.at(0)?.year ?? 0, 0, 1),
    [gantt.timelineData]
  );
  const [startAt, setStartAt] = useState<Date>(feature.startAt);
  const [endAt, setEndAt] = useState<Date | null>(feature.endAt);

  // Follow the dates the parent passes in (reload after a failed save,
  // optimistic update, edit from the task panel). Keyed on the timestamps so a
  // new Date instance with the same value does not reset an in-flight drag.
  const featureStartMs = feature.startAt.getTime();
  const featureEndMs = feature.endAt?.getTime() ?? null;
  useEffect(() => {
    setStartAt(new Date(featureStartMs));
    setEndAt(featureEndMs === null ? null : new Date(featureEndMs));
  }, [featureStartMs, featureEndMs]);

  // Memoize expensive calculations
  const width = useMemo(
    () => getWidth(startAt, endAt, gantt),
    [startAt, endAt, gantt]
  );
  const offset = useMemo(
    () => getOffset(startAt, timelineStartDate, gantt),
    [startAt, timelineStartDate, gantt]
  );

  const addRange = useMemo(() => getAddRange(gantt.range), [gantt.range]);

  // Dates at the moment a drag began. Refs, not state: dnd-kit fires
  // onDragMove right after onDragStart, before React re-renders, so state
  // would still hold the previous drag's values.
  const dragOrigin = useRef<{ start: Date; end: Date | null }>({
    start: feature.startAt,
    end: feature.endAt,
  });
  // The latest dates, readable from onDragEnd without waiting for a render.
  const latest = useRef<{ start: Date; end: Date | null }>({
    start: startAt,
    end: endAt,
  });
  latest.current = { start: startAt, end: endAt };

  const mouseSensor = useSensor(MouseSensor, {
    activationConstraint: {
      distance: 10,
    },
  });

  const handleDragStart = useCallback(() => {
    dragOrigin.current = { start: startAt, end: endAt };
  }, [startAt, endAt]);

  // Moving the whole bar: shift both ends by the number of whole days the
  // pointer travelled at the current scale (event.delta is pixels since the
  // drag started). Time of day is preserved.
  const handleItemDragMove = useCallback(
    ({ delta }: DragMoveEvent) => {
      const { start, end } = dragOrigin.current;
      const days = getDragShiftDays(delta.x, start, timelineStartDate, gantt);

      latest.current = {
        start: addDays(start, days),
        end: end ? addDays(end, days) : null,
      };
      setStartAt(latest.current.start);
      setEndAt(latest.current.end);
    },
    [gantt, timelineStartDate]
  );

  const handleLeftDragMove = useCallback(
    ({ delta }: DragMoveEvent) => {
      const { start, end } = dragOrigin.current;
      const originOffset = getOffset(start, timelineStartDate, gantt);
      const next = getDateAtOffset(originOffset + delta.x, timelineStartDate, gantt);
      // The start can't pass the end.
      const clamped = end && next > end ? startOfDay(end) : next;

      latest.current = { start: clamped, end: latest.current.end };
      setStartAt(clamped);
    },
    [gantt, timelineStartDate]
  );

  const handleRightDragMove = useCallback(
    ({ delta }: DragMoveEvent) => {
      const { start, end } = dragOrigin.current;
      const originEnd = end ?? addRange(start, 2);
      const originOffset = getOffset(originEnd, timelineStartDate, gantt);
      const next = getDateAtOffset(originOffset + delta.x, timelineStartDate, gantt);
      // The end can't pass the start.
      const clamped = next < start ? startOfDay(start) : next;

      latest.current = { start: latest.current.start, end: clamped };
      setEndAt(clamped);
    },
    [gantt, timelineStartDate, addRange]
  );

  const onDragEnd = useCallback(() => {
    const { start, end } = latest.current;
    const origin = dragOrigin.current;
    const unchanged =
      start.getTime() === origin.start.getTime() &&
      (end?.getTime() ?? null) === (origin.end?.getTime() ?? null);

    if (!unchanged) {
      onMove?.(feature.id, start, end);
    }
  }, [onMove, feature.id]);

  return (
    <div
      className={cn('relative flex w-max min-w-full py-0.5', className)}
      style={{ height: 'var(--gantt-row-height)' }}
    >
      <div
        className="pointer-events-auto absolute top-0.5"
        style={{
          height: 'calc(var(--gantt-row-height) - 4px)',
          width: Math.round(width),
          left: Math.round(offset),
        }}
      >
        {onMove && (
          <DndContext
            modifiers={[restrictToHorizontalAxis]}
            onDragEnd={onDragEnd}
            onDragMove={handleLeftDragMove}
            onDragStart={handleDragStart}
            sensors={[mouseSensor]}
          >
            <GanttFeatureDragHelper
              date={startAt}
              direction="left"
              featureId={feature.id}
            />
          </DndContext>
        )}
        <DndContext
          modifiers={[restrictToHorizontalAxis]}
          onDragEnd={onDragEnd}
          onDragMove={handleItemDragMove}
          onDragStart={handleDragStart}
          sensors={[mouseSensor]}
        >
          <GanttFeatureItemCard
            id={feature.id}
            color={feature.status?.color}
            unscheduled={feature.unscheduled}
          >
            {children ?? (
              <p className="flex-1 truncate text-xs">{feature.name}</p>
            )}
          </GanttFeatureItemCard>
        </DndContext>
        {onMove && (
          <DndContext
            modifiers={[restrictToHorizontalAxis]}
            onDragEnd={onDragEnd}
            onDragMove={handleRightDragMove}
            onDragStart={handleDragStart}
            sensors={[mouseSensor]}
          >
            <GanttFeatureDragHelper
              date={endAt ?? addRange(startAt, 2)}
              direction="right"
              featureId={feature.id}
            />
          </DndContext>
        )}
      </div>
    </div>
  );
};

export type GanttFeatureListGroupProps = {
  children: ReactNode;
  className?: string;
};

export const GanttFeatureListGroup: FC<GanttFeatureListGroupProps> = ({
  children,
  className,
}) => (
  <div className={className} style={{ paddingTop: 'var(--gantt-row-height)' }}>
    {children}
  </div>
);

export type GanttFeatureRowProps = {
  features: GanttFeature[];
  onMove?: (id: string, startAt: Date, endAt: Date | null) => void;
  children?: (feature: GanttFeature) => ReactNode;
  className?: string;
};

export const GanttFeatureRow: FC<GanttFeatureRowProps> = ({
  features,
  onMove,
  children,
  className,
}) => {
  // Sort features by start date to handle potential overlaps
  const sortedFeatures = [...features].sort((a, b) =>
    a.startAt.getTime() - b.startAt.getTime()
  );

  // Calculate sub-row positions for overlapping features using a proper algorithm
  const featureWithPositions = [];
  const subRowEndTimes: Date[] = []; // Track when each sub-row becomes free

  for (const feature of sortedFeatures) {
    let subRow = 0;

    // Find the first sub-row that's free (doesn't overlap)
    while (subRow < subRowEndTimes.length && subRowEndTimes[subRow]! > feature.startAt) {
      subRow++;
    }

    // Update the end time for this sub-row
    if (subRow === subRowEndTimes.length) {
      subRowEndTimes.push(feature.endAt);
    } else {
      subRowEndTimes[subRow] = feature.endAt;
    }

    featureWithPositions.push({ ...feature, subRow });
  }

  const maxSubRows = Math.max(1, subRowEndTimes.length);
  const subRowHeight = 36; // Base row height

  return (
    <div
      className={cn('relative', className)}
      style={{
        height: `${maxSubRows * subRowHeight}px`,
        minHeight: 'var(--gantt-row-height)'
      }}
    >
      {featureWithPositions.map((feature) => (
        <div
          key={feature.id}
          className="absolute w-full"
          style={{
            top: `${feature.subRow * subRowHeight}px`,
            height: `${subRowHeight}px`
          }}
        >
          <GanttFeatureItem
            {...feature}
            onMove={onMove}
          >
            {children ? children(feature) : (
              <p className="flex-1 truncate text-xs">{feature.name}</p>
            )}
          </GanttFeatureItem>
        </div>
      ))}
    </div>
  );
};

export type GanttFeatureListProps = {
  className?: string;
  children: ReactNode;
};

export const GanttFeatureList: FC<GanttFeatureListProps> = ({
  className,
  children,
}) => (
  <div
    className={cn('absolute top-0 left-0 h-full w-max space-y-4', className)}
    style={{ marginTop: 'var(--gantt-header-height)' }}
  >
    {children}
  </div>
);

export type GanttSubtaskConnectorProps = {
  feature: GanttFeature;
  parentFeature: GanttFeature;
};

export const GanttSubtaskConnector: FC<GanttSubtaskConnectorProps> = ({
  feature,
  parentFeature,
}) => {
  const gantt = useContext(GanttContext);
  const timelineStartDate = useMemo(
    () => new Date(gantt.timelineData.at(0)?.year ?? 0, 0, 1),
    [gantt.timelineData]
  );

  const parentEndX = useMemo(() => {
    const parentOffset = getOffset(parentFeature.startAt, timelineStartDate, gantt);
    const parentWidth = getWidth(parentFeature.startAt, parentFeature.endAt, gantt);
    return parentOffset + parentWidth;
  }, [parentFeature, timelineStartDate, gantt]);

  const childStartX = useMemo(
    () => getOffset(feature.startAt, timelineStartDate, gantt),
    [feature.startAt, timelineStartDate, gantt]
  );

  // Position the vertical line 12px after the parent task ends
  const verticalLineX = parentEndX + 12;

  return (
    <>
      {/* Horizontal line to subtask */}
      <div
        className="absolute pointer-events-none z-10"
        style={{
          left: verticalLineX,
          top: '50%',
          width: Math.max(0, childStartX - verticalLineX - 4),
          height: 2,
          backgroundColor: '#a1a1aa', // zinc-400
          transform: 'translateY(-50%)',
        }}
      />
      {/* Small arrow/dot at the end pointing to subtask */}
      <div
        className="absolute pointer-events-none z-10 rounded-full"
        style={{
          left: childStartX - 6,
          top: '50%',
          width: 4,
          height: 4,
          backgroundColor: '#a1a1aa', // zinc-400
          transform: 'translateY(-50%)',
        }}
      />
    </>
  );
};

export type GanttTreeViewProps = {
  features: GanttFeature[];
  renderFeature: (feature: GanttFeature, index: number) => ReactNode;
  className?: string;
};

export const GanttTreeView: FC<GanttTreeViewProps> = ({
  features,
  renderFeature,
  className,
}) => {
  // Build parent map
  const parentMap = useMemo(() => {
    const map = new Map<string, GanttFeature>();
    features.forEach((f) => {
      map.set(f.id, f);
    });
    return map;
  }, [features]);

  return (
    <div className={cn('relative', className)}>
      {features.map((feature, index) => {
        const parentFeature = feature.parentTaskId ? parentMap.get(feature.parentTaskId) : undefined;

        return (
          <div
            key={feature.id}
            className="relative"
            style={{ height: 'var(--gantt-row-height)' }}
          >
            {feature.isSubtask && parentFeature && (
              <GanttSubtaskConnector
                feature={feature}
                parentFeature={parentFeature}
              />
            )}
            {renderFeature(feature, index)}
          </div>
        );
      })}
    </div>
  );
};

export const GanttMarker: FC<
  GanttMarkerProps & {
    onRemove?: (id: string) => void;
    onRename?: (id: string) => void;
    onSelect?: (id: string, event?: React.MouseEvent) => void;
    className?: string;
  }
> = memo(({ label, date, id, onRemove, onRename, onSelect, className }) => {
  const gantt = useContext(GanttContext);
  const differenceIn = useMemo(
    () => getDifferenceIn(gantt.range),
    [gantt.range]
  );
  const timelineStartDate = useMemo(
    () => new Date(gantt.timelineData.at(0)?.year ?? 0, 0, 1),
    [gantt.timelineData]
  );

  // Memoize expensive calculations
  const offset = useMemo(
    () => differenceIn(date, timelineStartDate),
    [differenceIn, date, timelineStartDate]
  );
  const innerOffset = useMemo(
    () =>
      calculateInnerOffset(
        date,
        gantt.range,
        (gantt.columnWidth * gantt.zoom) / 100
      ),
    [date, gantt.range, gantt.columnWidth, gantt.zoom]
  );

  const handleRemove = useCallback(() => onRemove?.(id), [onRemove, id]);
  const handleRename = useCallback(() => onRename?.(id), [onRename, id]);
  const handleSelect = useCallback((event?: React.MouseEvent) => onSelect?.(id, event), [onSelect, id]);

  return (
    <div
      className="pointer-events-none absolute top-0 left-0 z-20 flex h-full select-none flex-col items-center justify-center overflow-visible"
      style={{
        width: 0,
        transform: `translateX(calc(var(--gantt-column-width) * ${offset} + ${innerOffset}px))`,
      }}
    >
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            className={cn(
              'group pointer-events-auto sticky top-0 flex select-auto flex-col flex-nowrap items-center justify-center whitespace-nowrap rounded-b-md bg-card px-2 py-1 text-foreground text-xs cursor-pointer',
              className
            )}
            onClick={(e) => handleSelect(e)}
          >
            {label}
            <span className="max-h-[0] overflow-hidden opacity-80 transition-all group-hover:max-h-[2rem] group-focus-visible:max-h-[2rem]">
              {formatDate(date, 'MMM dd, yyyy', { locale: gantt.locale })}
            </span>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {onRename ? (
            <ContextMenuItem
              className="flex items-center gap-2"
              onClick={handleRename}
            >
              <PencilIcon size={16} className="text-muted-foreground" />
              Rename
            </ContextMenuItem>
          ) : null}
          {onRemove ? (
            <ContextMenuItem
              className="flex items-center gap-2 text-destructive"
              onClick={handleRemove}
            >
              <TrashIcon size={16} />
              Remove marker
            </ContextMenuItem>
          ) : null}
        </ContextMenuContent>
      </ContextMenu>
      <div className={cn('h-full w-px bg-card', className)} />
    </div>
  );
});

GanttMarker.displayName = 'GanttMarker';

export type GanttProviderProps = {
  locale?: Locale;
  labels?: GanttLabels;
  range?: Range;
  zoom?: number;
  onAddItem?: (date: Date) => void;
  children: ReactNode;
  className?: string;
};

export const GanttProvider: FC<GanttProviderProps> = ({
  locale,
  labels,
  zoom = 100,
  range = 'monthly',
  onAddItem,
  children,
  className,
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [timelineData, setTimelineData] = useState<TimelineData>(
    createInitialTimelineData(new Date())
  );
  const [, setScrollX] = useGanttScrollX();
  const [sidebarWidth, setSidebarWidth] = useState(0);

  const headerHeight = 60;
  const rowHeight = 36;
  let columnWidth = 50;

  if (range === 'monthly') {
    columnWidth = 150;
  } else if (range === 'quarterly') {
    columnWidth = 100;
  }

  // Memoize CSS variables to prevent unnecessary re-renders
  const cssVariables = useMemo(
    () =>
      ({
        '--gantt-zoom': `${zoom}`,
        '--gantt-column-width': `${(zoom / 100) * columnWidth}px`,
        '--gantt-header-height': `${headerHeight}px`,
        '--gantt-row-height': `${rowHeight}px`,
        '--gantt-sidebar-width': `${sidebarWidth}px`,
      }) as CSSProperties,
    [zoom, columnWidth, sidebarWidth]
  );

  // Open on today: put the today line 20% into the visible timeline area
  // (right of the sidebar). Runs on mount and when the range (day / week /
  // month / quarter) changes, since column widths change and the old scroll
  // position would land somewhere unrelated.
  useEffect(() => {
    const scrollElement = scrollRef.current;
    if (!scrollElement) {
      return;
    }

    const hasSidebar = Boolean(
      scrollElement.querySelector('[data-roadmap-ui="gantt-sidebar"]')
    );
    const sidebar = hasSidebar ? SIDEBAR_WIDTH : 0;
    const timelineStart = new Date(timelineData.at(0)?.year ?? 0, 0, 1);
    const todayOffset = getOffset(new Date(), timelineStart, {
      range,
      columnWidth,
      zoom,
    });

    scrollElement.scrollLeft = Math.max(
      0,
      todayOffset - (scrollElement.clientWidth - sidebar) * 0.2
    );
    setScrollX(scrollElement.scrollLeft);
    // Zoom changes are left to the host: it may want to keep the user's position.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range]);

  // Update sidebar width when DOM is ready
  useEffect(() => {
    const updateSidebarWidth = () => {
      const sidebarElement = scrollRef.current?.querySelector(
        '[data-roadmap-ui="gantt-sidebar"]'
      );
      const newWidth = sidebarElement ? SIDEBAR_WIDTH : 0;
      setSidebarWidth(newWidth);
    };

    // Update immediately
    updateSidebarWidth();

    // Also update on resize or when children change
    const observer = new MutationObserver(updateSidebarWidth);
    if (scrollRef.current) {
      observer.observe(scrollRef.current, {
        childList: true,
        subtree: true,
      });
    }

    return () => {
      observer.disconnect();
    };
  }, []);

  // Fix the useCallback to include all dependencies
  const handleScroll = useMemo(
    () => throttle(() => {
      const scrollElement = scrollRef.current;
      if (!scrollElement) {
        return;
      }

      const { scrollLeft, scrollWidth, clientWidth } = scrollElement;
      setScrollX(scrollLeft);

      if (scrollLeft === 0) {
        // Extend timelineData to the past
        const firstYear = timelineData[0]?.year;

        if (!firstYear) {
          return;
        }

        const newTimelineData: TimelineData = [...timelineData];
        newTimelineData.unshift({
          year: firstYear - 1,
          quarters: new Array(4).fill(null).map((_, quarterIndex) => ({
            months: new Array(3).fill(null).map((_, monthIndex) => {
              const month = quarterIndex * 3 + monthIndex;
              return {
                days: getDaysInMonth(new Date(firstYear, month, 1)),
              };
            }),
          })),
        });

        setTimelineData(newTimelineData);

        // Scroll a bit forward so it's not at the very start
        scrollElement.scrollLeft = scrollElement.clientWidth;
        setScrollX(scrollElement.scrollLeft);
      } else if (scrollLeft + clientWidth >= scrollWidth) {
        // Extend timelineData to the future
        const lastYear = timelineData.at(-1)?.year;

        if (!lastYear) {
          return;
        }

        const newTimelineData: TimelineData = [...timelineData];
        newTimelineData.push({
          year: lastYear + 1,
          quarters: new Array(4).fill(null).map((_, quarterIndex) => ({
            months: new Array(3).fill(null).map((_, monthIndex) => {
              const month = quarterIndex * 3 + monthIndex;
              return {
                days: getDaysInMonth(new Date(lastYear, month, 1)),
              };
            }),
          })),
        });

        setTimelineData(newTimelineData);

        // Scroll a bit back so it's not at the very end
        scrollElement.scrollLeft =
          scrollElement.scrollWidth - scrollElement.clientWidth;
        setScrollX(scrollElement.scrollLeft);
      }
    }, 100),
    [timelineData, setScrollX]
  );

  useEffect(() => {
    const scrollElement = scrollRef.current;
    if (scrollElement) {
      scrollElement.addEventListener('scroll', handleScroll);
    }

    return () => {
      // Fix memory leak by properly referencing the scroll element
      if (scrollElement) {
        scrollElement.removeEventListener('scroll', handleScroll);
      }
    };
  }, [handleScroll]);

  const scrollToFeature = useCallback((feature: GanttFeature) => {
    const scrollElement = scrollRef.current;
    if (!scrollElement) {
      return;
    }

    // Calculate timeline start date from timelineData
    const timelineStartDate = new Date(timelineData.at(0)?.year ?? 0, 0, 1);

    // Calculate the horizontal offset for the feature's start date
    const offset = getOffset(feature.startAt, timelineStartDate, {
      zoom,
      range,
      columnWidth,
    });

    // Scroll to align the feature's start with the right side of the sidebar
    const targetScrollLeft = Math.max(0, offset);

    scrollElement.scrollTo({
      left: targetScrollLeft,
      behavior: 'smooth',
    });
  }, [timelineData, zoom, range, columnWidth]);

  const contextValue = useMemo(
    () => ({
      locale,
      labels,
      zoom,
      range,
      headerHeight,
      columnWidth,
      sidebarWidth,
      rowHeight,
      onAddItem,
      timelineData,
      placeholderLength: 2,
      ref: scrollRef,
      scrollToFeature,
    }),
    [
      zoom, range, headerHeight, columnWidth, sidebarWidth, rowHeight, onAddItem, timelineData,
      scrollRef, scrollToFeature, locale, labels,
    ]
  );

  return (
    <GanttContext.Provider
      value={contextValue}
    >
      <div
        className={cn(
          'gantt relative grid min-h-full w-full flex-1 select-none overflow-auto rounded-sm bg-secondary',
          range,
          className
        )}
        ref={scrollRef}
        style={{
          ...cssVariables,
          gridTemplateColumns: 'var(--gantt-sidebar-width) 1fr',
        }}
      >
        {children}
      </div>
    </GanttContext.Provider>
  );
};

export type GanttTimelineProps = {
  children: ReactNode;
  className?: string;
};

export const GanttTimeline: FC<GanttTimelineProps> = ({
  children,
  className,
}) => (
  <div
    className={cn(
      'relative flex min-h-full w-max flex-none overflow-clip',
      className
    )}
  >
    {children}
  </div>
);

export type GanttTodayProps = {
  className?: string;
};

export const GanttToday: FC<GanttTodayProps> = ({ className }) => {
  const date = useMemo(() => new Date(), []);
  const gantt = useContext(GanttContext);
  const label = gantt.labels?.today ?? 'Today';
  const timelineStartDate = useMemo(
    () => new Date(gantt.timelineData.at(0)?.year ?? 0, 0, 1),
    [gantt.timelineData]
  );

  // Same scale and convention as the bars, so a task due today ends on the line.
  const offset = useMemo(
    () =>
      getOffset(date, timelineStartDate, {
        range: gantt.range,
        columnWidth: gantt.columnWidth,
        zoom: gantt.zoom,
      }),
    [date, timelineStartDate, gantt.range, gantt.columnWidth, gantt.zoom]
  );

  return (
    <div
      className="pointer-events-none absolute top-0 left-0 z-20 flex h-full select-none flex-col items-center justify-center overflow-visible"
      data-roadmap-ui="gantt-today"
      style={{
        width: 0,
        transform: `translateX(${offset}px)`,
      }}
    >
      <div
        className={cn(
          'group pointer-events-auto sticky top-0 flex select-auto flex-col flex-nowrap items-center justify-center whitespace-nowrap rounded-b-md px-2 py-1 text-white text-xs',
          className
        )}
        style={{ backgroundColor: '#2563eb' }}
      >
        {label}
        <span className="max-h-[0] overflow-hidden opacity-80 transition-all group-hover:max-h-[2rem]">
          {formatDate(date, 'MMM dd, yyyy', { locale: gantt.locale })}
        </span>
      </div>
      <div className="h-full w-px" style={{ backgroundColor: '#2563eb' }} />
    </div>
  );
};
