import {
  Globe,
  FileText,
  Star,
  PhoneIncoming,
  PhoneOutgoing,
  Video,
  Phone,
  Calendar,
  FolderKanban,
  AtSign,
  Reply,
  MessageCircle,
  User,
  Play,
  CheckCircle2,
  XCircle,
  Clock,
  Ban,
  Building2,
  Pause,
  Webhook,
  Activity,
  Hash,
  Slack,
  Bot,
  MessagesSquare,
} from 'lucide-react';
import * as React from 'react';
import { Bar, BarChart, CartesianGrid, XAxis } from 'recharts';
import { Link } from '@tanstack/react-router';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { Button } from '@weldsuite/ui/components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@weldsuite/ui/components/card';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@weldsuite/ui/components/chart';
import { SkeletonRows, EmptyState, DemoBadge } from '@/lib/home-widgets/common';
import {
  ConversationListItem,
  groupByDate,
  type ConversationItem,
} from '@/components/shared/conversation-list';
// ---------- Analytics — activity across the whole WeldSuite ----------
const chartData = [
  { date: "2024-04-01", desktop: 222, mobile: 150 },
  { date: "2024-04-02", desktop: 97, mobile: 180 },
  { date: "2024-04-03", desktop: 167, mobile: 120 },
  { date: "2024-04-04", desktop: 242, mobile: 260 },
  { date: "2024-04-05", desktop: 373, mobile: 290 },
  { date: "2024-04-06", desktop: 301, mobile: 340 },
  { date: "2024-04-07", desktop: 245, mobile: 180 },
  { date: "2024-04-08", desktop: 409, mobile: 320 },
  { date: "2024-04-09", desktop: 59, mobile: 110 },
  { date: "2024-04-10", desktop: 261, mobile: 190 },
  { date: "2024-04-11", desktop: 327, mobile: 350 },
  { date: "2024-04-12", desktop: 292, mobile: 210 },
  { date: "2024-04-13", desktop: 342, mobile: 380 },
  { date: "2024-04-14", desktop: 137, mobile: 220 },
  { date: "2024-04-15", desktop: 120, mobile: 170 },
  { date: "2024-04-16", desktop: 138, mobile: 190 },
  { date: "2024-04-17", desktop: 446, mobile: 360 },
  { date: "2024-04-18", desktop: 364, mobile: 410 },
  { date: "2024-04-19", desktop: 243, mobile: 180 },
  { date: "2024-04-20", desktop: 89, mobile: 150 },
  { date: "2024-04-21", desktop: 137, mobile: 200 },
  { date: "2024-04-22", desktop: 224, mobile: 170 },
  { date: "2024-04-23", desktop: 138, mobile: 230 },
  { date: "2024-04-24", desktop: 387, mobile: 290 },
  { date: "2024-04-25", desktop: 215, mobile: 250 },
  { date: "2024-04-26", desktop: 75, mobile: 130 },
  { date: "2024-04-27", desktop: 383, mobile: 420 },
  { date: "2024-04-28", desktop: 122, mobile: 180 },
  { date: "2024-04-29", desktop: 315, mobile: 240 },
  { date: "2024-04-30", desktop: 454, mobile: 380 },
  { date: "2024-05-01", desktop: 165, mobile: 220 },
  { date: "2024-05-02", desktop: 293, mobile: 310 },
  { date: "2024-05-03", desktop: 247, mobile: 190 },
  { date: "2024-05-04", desktop: 385, mobile: 420 },
  { date: "2024-05-05", desktop: 481, mobile: 390 },
  { date: "2024-05-06", desktop: 498, mobile: 520 },
  { date: "2024-05-07", desktop: 388, mobile: 300 },
  { date: "2024-05-08", desktop: 149, mobile: 210 },
  { date: "2024-05-09", desktop: 227, mobile: 180 },
  { date: "2024-05-10", desktop: 293, mobile: 330 },
  { date: "2024-05-11", desktop: 335, mobile: 270 },
  { date: "2024-05-12", desktop: 197, mobile: 240 },
  { date: "2024-05-13", desktop: 197, mobile: 160 },
  { date: "2024-05-14", desktop: 448, mobile: 490 },
  { date: "2024-05-15", desktop: 473, mobile: 380 },
  { date: "2024-05-16", desktop: 338, mobile: 400 },
  { date: "2024-05-17", desktop: 499, mobile: 420 },
  { date: "2024-05-18", desktop: 315, mobile: 350 },
  { date: "2024-05-19", desktop: 235, mobile: 180 },
  { date: "2024-05-20", desktop: 177, mobile: 230 },
  { date: "2024-05-21", desktop: 82, mobile: 140 },
  { date: "2024-05-22", desktop: 81, mobile: 120 },
  { date: "2024-05-23", desktop: 252, mobile: 290 },
  { date: "2024-05-24", desktop: 294, mobile: 220 },
  { date: "2024-05-25", desktop: 201, mobile: 250 },
  { date: "2024-05-26", desktop: 213, mobile: 170 },
  { date: "2024-05-27", desktop: 420, mobile: 460 },
  { date: "2024-05-28", desktop: 233, mobile: 190 },
  { date: "2024-05-29", desktop: 78, mobile: 130 },
  { date: "2024-05-30", desktop: 340, mobile: 280 },
  { date: "2024-05-31", desktop: 178, mobile: 230 },
  { date: "2024-06-01", desktop: 178, mobile: 200 },
  { date: "2024-06-02", desktop: 470, mobile: 410 },
  { date: "2024-06-03", desktop: 103, mobile: 160 },
  { date: "2024-06-04", desktop: 439, mobile: 380 },
  { date: "2024-06-05", desktop: 88, mobile: 140 },
  { date: "2024-06-06", desktop: 294, mobile: 250 },
  { date: "2024-06-07", desktop: 323, mobile: 370 },
  { date: "2024-06-08", desktop: 385, mobile: 320 },
  { date: "2024-06-09", desktop: 438, mobile: 480 },
  { date: "2024-06-10", desktop: 155, mobile: 200 },
  { date: "2024-06-11", desktop: 92, mobile: 150 },
  { date: "2024-06-12", desktop: 492, mobile: 420 },
  { date: "2024-06-13", desktop: 81, mobile: 130 },
  { date: "2024-06-14", desktop: 426, mobile: 380 },
  { date: "2024-06-15", desktop: 307, mobile: 350 },
  { date: "2024-06-16", desktop: 371, mobile: 310 },
  { date: "2024-06-17", desktop: 475, mobile: 520 },
  { date: "2024-06-18", desktop: 107, mobile: 170 },
  { date: "2024-06-19", desktop: 341, mobile: 290 },
  { date: "2024-06-20", desktop: 408, mobile: 450 },
  { date: "2024-06-21", desktop: 169, mobile: 210 },
  { date: "2024-06-22", desktop: 317, mobile: 270 },
  { date: "2024-06-23", desktop: 480, mobile: 530 },
  { date: "2024-06-24", desktop: 132, mobile: 180 },
  { date: "2024-06-25", desktop: 141, mobile: 190 },
  { date: "2024-06-26", desktop: 434, mobile: 380 },
  { date: "2024-06-27", desktop: 448, mobile: 490 },
  { date: "2024-06-28", desktop: 149, mobile: 200 },
  { date: "2024-06-29", desktop: 103, mobile: 160 },
  { date: "2024-06-30", desktop: 446, mobile: 400 },
];

const CHART_COLORS = {
  desktop: "var(--chart-2)",
  mobile: "var(--chart-1)",
} as const;
type ChartKey = keyof typeof CHART_COLORS;

// Card has its own header chrome; the demo badge is handled by the caller.
export function AnalyticsCard(_props: Readonly<{ isDemo?: boolean }> = {}) {
  const { t, language } = useI18n();
  const tc = t.weldsuiteHome.cards;
  const chartConfig = React.useMemo(
    (): ChartConfig => ({
      views: { label: tc.analytics.pageViews },
      desktop: { label: tc.analytics.desktop, color: CHART_COLORS.desktop },
      mobile: { label: tc.analytics.mobile, color: CHART_COLORS.mobile },
    }),
    [tc],
  );
  const [activeChart, setActiveChart] =
    React.useState<ChartKey>("desktop");

  const total = React.useMemo(
    () => ({
      desktop: chartData.reduce((acc, curr) => acc + curr.desktop, 0),
      mobile: chartData.reduce((acc, curr) => acc + curr.mobile, 0),
    }),
    []
  );

  return (
    <Card className="py-0">
      <CardHeader className="flex flex-col items-stretch border-b p-0! sm:flex-row">
        <div className="flex flex-1 flex-col justify-center gap-1 px-6 pt-4 pb-3 sm:py-0!">
          <CardTitle>{tc.analytics.title}</CardTitle>
          <CardDescription>
            {tc.analytics.description}
          </CardDescription>
        </div>
        <div className="flex">
          {["desktop", "mobile"].map((key) => {
            const chart = key as ChartKey;
            return (
              <Button
                key={chart}
                variant="ghost"
                data-active={activeChart === chart}
                className="relative z-30 flex flex-1 flex-col justify-center gap-1 border-t px-6 py-4 text-left even:border-l data-[active=true]:bg-muted/50 sm:border-t-0 sm:border-l sm:px-8 sm:py-6"
                onClick={() => setActiveChart(chart)}
              >
                <span className="text-xs text-muted-foreground">
                  {chartConfig[chart].label}
                </span>
                <span className="text-lg leading-none font-bold sm:text-3xl">
                  {total[key as keyof typeof total].toLocaleString()}
                </span>
              </Button>
            );
          })}
        </div>
      </CardHeader>
      <CardContent className="px-2 sm:p-6">
        <ChartContainer
          config={chartConfig}
          className="aspect-auto h-[250px] w-full"
        >
          <BarChart
            accessibilityLayer
            data={chartData}
            margin={{
              left: 12,
              right: 12,
            }}
          >
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              minTickGap={32}
              tickFormatter={(value) => {
                const date = new Date(value);
                return date.toLocaleDateString(language, {
                  month: "short",
                  day: "numeric",
                });
              }}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  className="w-[150px]"
                  nameKey="views"
                  labelFormatter={(value) => {
                    return new Date(value).toLocaleDateString(language, {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    });
                  }}
                />
              }
            />
            <Bar dataKey={activeChart} fill={`var(--color-${activeChart})`} />
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

// Opt-in helper for row-based cards: measures direct children and hides any
// that overflow the wrapper, then drops the bottom border on the last visible
// child so it doesn't visually collide with the card's own bottom border.
// Cards with a single complex layout child (charts, kanban columns, calendar
// grids) should NOT use this — they'd get their entire body hidden when it
// overflows. Use it only when children are a flat list of row-shaped items.
//
// `stretch` distributes any leftover vertical space across the visible rows
// (via `flex: 1 1 auto`) so the last visible row's edge meets the card's
// bottom border. Children marked with `data-fit-fixed` (e.g. table headers,
// date dividers) are excluded from the stretch and keep their natural height.
function FitContent({
  children,
  className,
  stretch = false,
}: Readonly<{
  children: React.ReactNode;
  className?: string;
  stretch?: boolean;
}>) {
  const ref = React.useRef<HTMLDivElement>(null);

  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const measure = () => {
      const childNodes = Array.from(el.children) as HTMLElement[];
      for (const child of childNodes) {
        child.style.removeProperty('display');
        child.style.removeProperty('border-bottom-width');
        child.style.removeProperty('flex');
      }
      const containerBottom = el.getBoundingClientRect().bottom;
      let lastVisible = -1;
      for (let i = 0; i < childNodes.length; i++) {
        if (childNodes[i].getBoundingClientRect().bottom > containerBottom + 0.5) {
          for (let j = i; j < childNodes.length; j++) {
            childNodes[j].style.display = 'none';
          }
          break;
        }
        lastVisible = i;
      }
      if (stretch && lastVisible >= 0) {
        for (let i = 0; i <= lastVisible; i++) {
          if (childNodes[i].dataset.fitFixed === undefined) {
            childNodes[i].style.flex = '1 1 auto';
          }
        }
      }
      if (lastVisible >= 0) {
        childNodes[lastVisible].style.borderBottomWidth = '0';
      }
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  });

  return (
    <div
      ref={ref}
      className={cn('overflow-hidden', stretch ? 'flex flex-col h-full' : 'h-full', className)}
    >
      {children}
    </div>
  );
}

function CardShell({ action, children }: Readonly<{ action?: React.ReactNode; children: React.ReactNode }>) {
  return (
    <div className="rounded-2xl border border-border bg-card flex flex-col h-[415px] min-h-[415px] max-h-[415px] overflow-hidden">
      {action && (
        <div className="flex items-center justify-end gap-2 px-4 h-[42px] border-b border-border/70 shrink-0">
          {action}
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-hidden [&>*:last-child]:border-b-0">{children}</div>
    </div>
  );
}

// Reusable header row matching EntityList (entity-list.tsx)
function TableHeader({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="flex items-center gap-4 px-4 h-[35px] border-b border-border/70 bg-muted/30 sticky top-0 z-10">
      {children}
    </div>
  );
}

function HeaderCell({ children, className }: Readonly<{ children: React.ReactNode; className?: string }>) {
  return (
    <span className={cn('text-xs font-medium text-muted-foreground', className)}>
      {children}
    </span>
  );
}

// Reusable data row matching WeldFlow row styling
const ROW_CLASS =
  'flex items-center gap-4 px-4 h-[54px] hover:bg-gray-50 dark:hover:bg-secondary/50 cursor-pointer border-b border-gray-200/70 dark:border-border last:border-b-0';

/** A card row: a real button when it opens something, a plain div otherwise. */
function ClickableRow({
  onClick,
  className,
  children,
}: Readonly<{ onClick?: () => void; className?: string; children: React.ReactNode }>) {
  if (!onClick) return <div className={className}>{children}</div>;
  return (
    <button type="button" onClick={onClick} className={cn('w-full text-left', className)}>
      {children}
    </button>
  );
}

// ---------- WeldMail (renders ConversationListItem to match /weldmail/.../inbox exactly) ----------
export type MailRow = {
  id: string;
  accountId: string;
  name: string;
  email?: string;
  avatarUrl?: string;
  subject: string;
  preview: string;
  date: Date;
  isRead: boolean;
  isStarred: boolean;
  isPinned: boolean;
  hasAttachments: boolean;
  labels: string[];
  labelColors?: Record<string, string>;
  messageCount: number;
  unreadCount: number;
};

function demoDate(daysAgo: number, hour: number, minute: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, minute, 0, 0);
  return d;
}

const DEMO_EMAILS: MailRow[] = [
  { id: 'demo-1', accountId: 'demo', name: 'Sara Mertens', email: 'sara@example.com', subject: 'Re: Q2 invoicing review', preview: 'Looks great — one tweak on the VAT lines and we can send.', date: demoDate(0, 8, 42), isRead: false, isStarred: true, isPinned: false, hasAttachments: false, labels: [], messageCount: 1, unreadCount: 1 },
  { id: 'demo-2', accountId: 'demo', name: 'Acme Logistics', email: 'orders@example.com', subject: 'Shipment update — order #38421', preview: 'Tracking has been updated. Expected delivery is Thursday.', date: demoDate(0, 8, 14), isRead: false, isStarred: false, isPinned: true, hasAttachments: true, labels: [], messageCount: 1, unreadCount: 1 },
  { id: 'demo-3', accountId: 'demo', name: 'Jeroen Van Damme', email: 'jeroen@example.com', subject: 'Need approval on the supplier quote', preview: 'Hey — can you sign off on the quote before noon today?', date: demoDate(0, 7, 31), isRead: false, isStarred: false, isPinned: false, hasAttachments: false, labels: [], messageCount: 3, unreadCount: 1 },
  { id: 'demo-4', accountId: 'demo', name: 'Stripe', email: 'no-reply@stripe.com', subject: 'Payout of €4,820 sent to your bank', preview: 'A payout of €4,820.00 has been initiated to BE68***1234.', date: demoDate(1, 16, 12), isRead: true, isStarred: false, isPinned: false, hasAttachments: false, labels: [], messageCount: 1, unreadCount: 0 },
  { id: 'demo-5', accountId: 'demo', name: 'Lien De Smet', email: 'lien@example.com', subject: 'Roadmap doc v3', preview: 'Updated the doc with feedback from yesterday\'s sync.', date: demoDate(3, 10, 5), isRead: true, isStarred: false, isPinned: false, hasAttachments: true, labels: [], messageCount: 2, unreadCount: 0 },
];

function mailRowToConversationItem(row: MailRow): ConversationItem {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    avatarUrl: row.avatarUrl,
    subject: row.subject,
    preview: row.preview,
    date: row.date,
    isRead: row.isRead,
    isStarred: row.isStarred,
    hasAttachments: row.hasAttachments,
    labels: row.labels,
    labelColors: row.labelColors,
    messageCount: row.messageCount,
    unreadCount: row.unreadCount,
  };
}

export function MailCard({
  rows = DEMO_EMAILS,
  isLoading = false,
  isDemo = false,
}: Readonly<{
  rows?: MailRow[];
  isLoading?: boolean;
  isDemo?: boolean;
}> = {}) {
  if (isLoading) {
    return (
      <CardShell>
        <div className="p-3"><SkeletonRows count={5} variant="list" /></div>
      </CardShell>
    );
  }
  if (rows.length === 0) {
    return (
      <CardShell>
        <EmptyState kind="mail" />
      </CardShell>
    );
  }
  const accountById = new Map(rows.map((r) => [r.id, r.accountId]));
  const pinnedSet = new Set(rows.filter((r) => r.isPinned).map((r) => r.id));
  const items = rows.map(mailRowToConversationItem);
  // Pinned first — mirrors ConversationList behavior
  items.sort((a, b) => (pinnedSet.has(b.id) ? 1 : 0) - (pinnedSet.has(a.id) ? 1 : 0));
  // Cap at 5 rows — the home card is sized to display exactly 5 emails.
  const cappedItems = items.slice(0, 5);
  const grouped = groupByDate(cappedItems);

  return (
    <CardShell action={isDemo ? <DemoBadge /> : null}>
      <FitContent stretch>
        {Object.entries(grouped).flatMap(([dateLabel, group]) => {
          const nodes: React.ReactNode[] = [];
          if (dateLabel !== 'Today') {
            nodes.push(
              <div
                key={`header-${dateLabel}`}
                data-fit-fixed
                className="relative -mt-px flex items-center gap-2 px-3 md:px-4 h-8 bg-background border-t border-b border-border/70"
              >
                <div className="absolute inset-0 bg-muted/50 pointer-events-none" />
                <span className="relative text-xs font-medium text-muted-foreground">{dateLabel}</span>
                <span className="relative text-[10px] font-mono text-muted-foreground bg-muted border border-border w-[16px] h-[16px] flex items-center justify-center rounded-[5px] -translate-y-px">
                  <span className="translate-y-[1px]">{group.length}</span>
                </span>
              </div>,
            );
          }
          for (const item of group) {
            const accountId = accountById.get(item.id) ?? '';
            const href = accountId ? `/weldmail/${accountId}/inbox/${item.id}` : '#';
            nodes.push(
              <ConversationListItem
                key={item.id}
                item={item}
                href={href}
                isPinned={pinnedSet.has(item.id)}
                compact
              />,
            );
          }
          return nodes;
        })}
      </FitContent>
    </CardShell>
  );
}

// ---------- WeldFlow ----------
export type FlowStatus = 'todo' | 'in_progress' | 'review' | 'done';
export type FlowPriority = 'high' | 'medium' | 'low';

const FLOW_STATUS: Record<FlowStatus, { color: string; bg: string }> = {
  todo: { color: 'text-gray-700 dark:text-gray-300', bg: 'bg-gray-100 dark:bg-gray-800' },
  in_progress: { color: 'text-blue-700 dark:text-blue-300', bg: 'bg-blue-100 dark:bg-blue-900/40' },
  review: { color: 'text-amber-700 dark:text-amber-300', bg: 'bg-amber-100 dark:bg-amber-900/40' },
  done: { color: 'text-emerald-700 dark:text-emerald-300', bg: 'bg-emerald-100 dark:bg-emerald-900/40' },
};

const FLOW_PRIORITY: Record<FlowPriority, { color: string; bg: string }> = {
  high: { color: 'text-red-700 dark:text-red-300', bg: 'bg-red-100 dark:bg-red-900/40' },
  medium: { color: 'text-orange-700 dark:text-orange-300', bg: 'bg-orange-100 dark:bg-orange-900/40' },
  low: { color: 'text-gray-600 dark:text-gray-400', bg: 'bg-gray-100 dark:bg-gray-800' },
};

export type FlowRow = {
  id?: string;
  title: string;
  project: string;
  status: FlowStatus;
  priority: FlowPriority;
};

const DEMO_TASKS: FlowRow[] = [
  { title: 'Wire app-api auth middleware', project: 'Backend', status: 'in_progress', priority: 'high' },
  { title: 'Migrate /quotes route to app-api', project: 'WeldCRM', status: 'todo', priority: 'high' },
  { title: 'Design Q3 onboarding flow', project: 'Growth', status: 'review', priority: 'medium' },
  { title: 'Review pricing page copy', project: 'Marketing', status: 'todo', priority: 'low' },
  { title: 'Investigate Stripe webhook retries', project: 'Billing', status: 'in_progress', priority: 'medium' },
  { title: 'Polish dark mode for app cards', project: 'Platform', status: 'in_progress', priority: 'low' },
  { title: 'Ship the new home dashboard', project: 'Platform', status: 'done', priority: 'medium' },
];

export function FlowCard({
  rows = DEMO_TASKS,
  isLoading = false,
  isDemo = false,
  onRowClick,
}: Readonly<{
  rows?: FlowRow[];
  isLoading?: boolean;
  isDemo?: boolean;
  onRowClick?: (row: FlowRow) => void;
}> = {}) {
  const { t } = useI18n();
  const tc = t.weldsuiteHome.cards;
  if (isLoading) {
    return (
      <CardShell>
        <div className="p-3"><SkeletonRows count={7} variant="table" /></div>
      </CardShell>
    );
  }
  if (rows.length === 0) {
    return (
      <CardShell>
        <EmptyState kind="tasks" />
      </CardShell>
    );
  }
  return (
    <CardShell action={isDemo ? <DemoBadge /> : null}>
      <FitContent>
        <TableHeader>
          <HeaderCell className="w-4 shrink-0 whitespace-nowrap">{tc.headers.task}</HeaderCell>
          <div className="flex-1" />
          <HeaderCell className="w-[100px]">{tc.headers.project}</HeaderCell>
          <HeaderCell className="w-[100px]">{tc.headers.status}</HeaderCell>
          <HeaderCell className="w-[80px]">{tc.headers.priority}</HeaderCell>
        </TableHeader>
        {rows.map((task) => {
          const status = FLOW_STATUS[task.status];
          const priority = FLOW_PRIORITY[task.priority];
          const isDone = task.status === 'done';
          const clickable = !!onRowClick && !!task.id;
          return (
            <ClickableRow
              key={task.id ?? task.title}
              className={cn(ROW_CLASS, isDone && 'opacity-50', clickable && 'cursor-pointer')}
              onClick={clickable ? () => onRowClick!(task) : undefined}
            >
              <span
                className={cn(
                  'h-4 w-4 rounded border flex items-center justify-center shrink-0',
                  isDone ? 'bg-primary border-primary' : 'border-border'
                )}
              >
                {isDone && (
                  <svg viewBox="0 0 24 24" className="h-3 w-3 text-primary-foreground" fill="none" stroke="currentColor" strokeWidth="3">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 12l5 5L20 7" />
                  </svg>
                )}
              </span>
              <span className={cn('flex-1 min-w-0 text-sm font-medium truncate', isDone ? 'line-through text-gray-400' : 'text-foreground')}>
                {task.title}
              </span>
              <span className="w-[100px] text-sm text-muted-foreground truncate">{task.project}</span>
              <span className="w-[100px]">
                <span className={cn('inline-block text-[11px] font-medium rounded px-2 py-0.5', status.color, status.bg)}>
                  {tc.flowStatus[task.status]}
                </span>
              </span>
              <span className="w-[80px]">
                <span className={cn('inline-block text-[11px] font-medium rounded px-2 py-0.5', priority.color, priority.bg)}>
                  {tc.flowPriority[task.priority]}
                </span>
              </span>
            </ClickableRow>
          );
        })}
      </FitContent>
    </CardShell>
  );
}

// ---------- WeldFlow Projects (matches all-projects-client.tsx exactly) ----------
export type ProjectStatus = 'on-track' | 'at-risk' | 'off-track' | 'on-hold' | 'completed';
export type ProjectPriority = 'critical' | 'high' | 'medium' | 'low';

const PROJECT_STATUS: Record<ProjectStatus, { color: string; bg: string }> = {
  'on-track': { color: 'text-emerald-600 dark:text-emerald-400', bg: 'bg-emerald-50 dark:bg-emerald-950' },
  'at-risk': { color: 'text-amber-600 dark:text-amber-400', bg: 'bg-amber-50 dark:bg-amber-950' },
  'off-track': { color: 'text-red-600 dark:text-red-400', bg: 'bg-red-50 dark:bg-red-950' },
  'on-hold': { color: 'text-gray-600 dark:text-muted-foreground', bg: 'bg-gray-100 dark:bg-secondary' },
  completed: { color: 'text-gray-600 dark:text-muted-foreground', bg: 'bg-gray-100 dark:bg-secondary' },
};

const PROJECT_PRIORITY: Record<ProjectPriority, { color: string; bg: string }> = {
  critical: { color: 'text-red-600 dark:text-red-400', bg: 'bg-red-50 dark:bg-red-950' },
  high: { color: 'text-orange-600 dark:text-orange-400', bg: 'bg-orange-50 dark:bg-orange-950' },
  medium: { color: 'text-blue-600 dark:text-blue-400', bg: 'bg-blue-50 dark:bg-blue-950' },
  low: { color: 'text-gray-600 dark:text-muted-foreground', bg: 'bg-gray-100 dark:bg-secondary' },
};

export type ProjectRow = {
  id?: string;
  name: string;
  color: string;
  status: ProjectStatus;
  priority: ProjectPriority;
  progress: number;
  due: string;
};

const DEMO_PROJECTS: ProjectRow[] = [
  { name: 'Platform redesign', color: 'bg-blue-500', status: 'on-track', priority: 'high', progress: 65, due: 'May 31' },
  { name: 'WeldCRM v2', color: 'bg-violet-500', status: 'at-risk', priority: 'critical', progress: 38, due: 'Jun 14' },
  { name: 'Q3 onboarding flow', color: 'bg-pink-500', status: 'on-hold', priority: 'medium', progress: 12, due: 'Jul 01' },
  { name: 'Stripe migration', color: 'bg-emerald-500', status: 'on-track', priority: 'high', progress: 78, due: 'May 28' },
  { name: 'Mobile app — Expo 54', color: 'bg-cyan-500', status: 'on-track', priority: 'medium', progress: 45, due: 'Aug 15' },
  { name: 'Marketing site refresh', color: 'bg-amber-500', status: 'off-track', priority: 'medium', progress: 30, due: 'Jun 20' },
  { name: 'API consolidation', color: 'bg-rose-500', status: 'on-track', priority: 'low', progress: 82, due: 'Jul 11' },
];

export function ProjectsCard({
  rows = DEMO_PROJECTS,
  isLoading = false,
  isDemo = false,
  onRowClick,
}: Readonly<{
  rows?: ProjectRow[];
  isLoading?: boolean;
  isDemo?: boolean;
  onRowClick?: (row: ProjectRow) => void;
}> = {}) {
  const { t } = useI18n();
  const tc = t.weldsuiteHome.cards;
  if (isLoading) {
    return (
      <CardShell>
        <div className="p-3"><SkeletonRows count={7} variant="table" /></div>
      </CardShell>
    );
  }
  if (rows.length === 0) {
    return (
      <CardShell>
        <EmptyState kind="projects" />
      </CardShell>
    );
  }
  return (
    <CardShell action={isDemo ? <DemoBadge /> : null}>
      <TableHeader>
        <HeaderCell className="flex-1 min-w-0">{tc.headers.project}</HeaderCell>
        <HeaderCell className="w-[90px]">{tc.headers.status}</HeaderCell>
        <HeaderCell className="w-[80px]">{tc.headers.priority}</HeaderCell>
        <HeaderCell className="w-[140px]">{tc.headers.progress}</HeaderCell>
        <HeaderCell className="w-[70px]">{tc.headers.dueDate}</HeaderCell>
      </TableHeader>
      {rows.map((p) => {
        const status = PROJECT_STATUS[p.status];
        const priority = PROJECT_PRIORITY[p.priority];
        const clickable = !!onRowClick && !!p.id;
        return (
          <ClickableRow
            key={p.id ?? p.name}
            className={cn(ROW_CLASS, clickable && 'cursor-pointer')}
            onClick={clickable ? () => onRowClick!(p) : undefined}
          >
            {/* Project name with colored icon square */}
            <div className="flex-1 min-w-0 flex items-center gap-2.5">
              <div className={cn('w-6 h-6 rounded-[8px] flex items-center justify-center flex-shrink-0', p.color)}>
                <FolderKanban className="h-3.5 w-3.5 text-white" />
              </div>
              <span className="text-sm font-medium text-foreground truncate">{p.name}</span>
            </div>

            {/* Status pill — exact h-[22px] px-2 rounded text-[12px] leading-none */}
            <div className="w-[90px]">
              <span className={cn('inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none', status.color, status.bg)}>
                {tc.projectStatus[p.status]}
              </span>
            </div>

            {/* Priority pill — same style */}
            <div className="w-[80px]">
              <span className={cn('inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none', priority.color, priority.bg)}>
                {tc.projectPriority[p.priority]}
              </span>
            </div>

            {/* Progress — h-[5px] bg-muted with bg-foreground fill */}
            <div className="w-[140px] flex items-center gap-3">
              <div className="flex-1 bg-muted rounded-full h-[5px]">
                <div className="h-[5px] rounded-full bg-foreground" style={{ width: `${p.progress}%` }} />
              </div>
              <span className="text-[12px] text-muted-foreground font-medium flex-shrink-0 w-9 text-left tabular-nums">
                {p.progress}%
              </span>
            </div>

            {/* Due date — small mono */}
            <div className="w-[70px]">
              <span className="text-sm text-muted-foreground font-mono">{p.due}</span>
            </div>
          </ClickableRow>
        );
      })}
    </CardShell>
  );
}

// ---------- WeldFlow Workload (matches workload-view.tsx — Gantt sidebar + timeline) ----------
const WORKLOAD_AVATARS = ['bg-blue-500', 'bg-violet-500', 'bg-pink-500', 'bg-emerald-500', 'bg-amber-500', 'bg-cyan-500', 'bg-rose-500'];

const WORKLOAD_ROW_HEIGHT = 54;

type WorkloadRole =
  | 'seniorFrontendEngineer'
  | 'backendEngineer'
  | 'customerSuccessLead'
  | 'salesManager'
  | 'designer'
  | 'devopsEngineer'
  | 'productManager';

const WORKLOAD: Array<{
  name: string;
  role: WorkloadRole;
  hours: number;
  hoursPerDay: number;
  tasks: number;
  chart: number[];
}> = [
  { name: 'Lien De Smet', role: 'seniorFrontendEngineer', hours: 7.6, hoursPerDay: 8, tasks: 18, chart: [72, 85, 88, 76, 45, 80, 92, 88, 84, 50, 85, 92, 86, 80] },
  { name: 'Tom Hendrickx', role: 'backendEngineer', hours: 6.4, hoursPerDay: 8, tasks: 14, chart: [65, 72, 70, 62, 30, 68, 75, 72, 70, 35, 72, 78, 70, 65] },
  { name: 'Sara Mertens', role: 'customerSuccessLead', hours: 8.8, hoursPerDay: 8, tasks: 22, chart: [105, 95, 88, 102, 60, 100, 120, 115, 108, 65, 110, 122, 105, 95] },
  { name: 'Jeroen Van Damme', role: 'salesManager', hours: 5.2, hoursPerDay: 8, tasks: 11, chart: [55, 60, 52, 48, 25, 55, 65, 60, 58, 28, 58, 65, 60, 52] },
  { name: 'Camille Rousseau', role: 'designer', hours: 4.0, hoursPerDay: 8, tasks: 8, chart: [42, 48, 38, 36, 15, 42, 52, 48, 45, 18, 45, 52, 48, 40] },
  { name: 'Pieter Janssens', role: 'devopsEngineer', hours: 7.2, hoursPerDay: 8, tasks: 16, chart: [75, 80, 72, 70, 38, 78, 85, 82, 80, 40, 80, 88, 82, 72] },
  { name: 'Maxime Leroy', role: 'productManager', hours: 5.6, hoursPerDay: 8, tasks: 12, chart: [60, 65, 55, 52, 28, 62, 70, 65, 62, 32, 65, 72, 65, 58] },
];

// Step chart matching WorkloadAreaChart — indigo area + line, max 150% utilization scale,
// row padded 4px from the top (maxHeight = rowHeight - 4, bottomY = rowHeight).
function WorkloadAreaChart({ data, rowHeight }: Readonly<{ data: number[]; rowHeight: number }>) {
  const maxUtilization = 150;
  const maxHeight = rowHeight - 4;
  const bottomY = rowHeight;
  const W = 200;
  const stepX = W / data.length;

  let area = `M 0 ${bottomY}`;
  let line = '';

  data.forEach((util, i) => {
    const clamped = Math.min(util, maxUtilization);
    const y = bottomY - (clamped / maxUtilization) * maxHeight;
    const startX = i * stepX;
    const endX = (i + 1) * stepX;
    if (i === 0) {
      area += ` L ${startX.toFixed(2)} ${y.toFixed(2)}`;
      line = `M ${startX.toFixed(2)} ${y.toFixed(2)}`;
    } else {
      area += ` L ${startX.toFixed(2)} ${y.toFixed(2)}`;
      line += ` L ${startX.toFixed(2)} ${y.toFixed(2)}`;
    }
    area += ` L ${endX.toFixed(2)} ${y.toFixed(2)}`;
    line += ` L ${endX.toFixed(2)} ${y.toFixed(2)}`;
  });

  area += ` L ${W} ${bottomY} Z`;

  return (
    <svg
      viewBox={`0 0 ${W} ${rowHeight}`}
      preserveAspectRatio="none"
      className="w-full h-full"
    >
      <path d={area} fill="rgba(99, 102, 241, 0.3)" />
      <path
        d={line}
        fill="none"
        stroke="rgb(99, 102, 241)"
        strokeWidth="2"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

export function WorkloadCard({
  isDemo = false,
}: Readonly<{ isDemo?: boolean }> = {}) {
  const { t, plural } = useI18n();
  const tc = t.weldsuiteHome.cards;
  return (
    <CardShell action={isDemo ? <DemoBadge /> : null}>
      {/* Header bar — split between Members/Availability (sidebar) and Utilization (timeline) */}
      <div className="flex h-[35px] border-b border-border/70 bg-muted/30 sticky top-0 z-10">
        <div className="w-[280px] shrink-0 border-r border-border/70 flex items-center justify-between px-3">
          <span className="text-xs font-medium text-muted-foreground">{tc.headers.members}</span>
          <span className="text-xs font-medium text-muted-foreground">{tc.headers.availability}</span>
        </div>
        <div className="flex-1 flex items-center px-3">
          <span className="text-xs font-medium text-muted-foreground">{tc.headers.utilizationLast14Days}</span>
        </div>
      </div>

      {/* Body — sidebar (TeamMemberSidebarItem) | timeline (WorkloadAreaChart) */}
      <div className="flex">
        {/* Sidebar column */}
        <div className="w-[280px] shrink-0 border-r border-border/70">
          {WORKLOAD.map((w, i) => {
            const initials = (w.name ?? '?').slice(0, 2);
            let hoursColor = 'text-muted-foreground';
            if (w.hours > w.hoursPerDay) {
              hoursColor = 'text-red-500';
            } else if (w.hours > w.hoursPerDay * 0.8) {
              hoursColor = 'text-green-500';
            }
            return (
              <div
                key={w.name}
                className="border-b border-border/50 last:border-b-0 flex items-center gap-3 px-3 cursor-pointer hover:bg-secondary/50"
                style={{ height: WORKLOAD_ROW_HEIGHT }}
              >
                <div
                  className={cn(
                    'h-[30px] w-[30px] rounded-lg flex items-center justify-center text-white font-medium text-xs shrink-0',
                    WORKLOAD_AVATARS[i % WORKLOAD_AVATARS.length]
                  )}
                >
                  {initials}
                </div>
                <div className="flex-1 min-w-0 -space-y-px">
                  <p className="text-sm font-medium truncate text-foreground">{w.name}</p>
                  <p className="text-xs text-muted-foreground truncate">{tc.workload.roles[w.role]}</p>
                </div>
                <div className="text-right space-y-0.5 shrink-0">
                  <p className={cn('text-xs font-medium', hoursColor)}>
                    {w.hours.toFixed(1)}h / {w.hoursPerDay}h
                  </p>
                  <p className="text-xs text-muted-foreground">{plural(w.tasks, tc.workload.tasks)}</p>
                </div>
              </div>
            );
          })}
        </div>

        {/* Timeline column — one area-chart row per member, vertically aligned with the sidebar */}
        <div className="flex-1 min-w-0">
          {WORKLOAD.map((w) => (
            <div
              key={w.name}
              className="relative border-b border-border last:border-b-0"
              style={{ height: WORKLOAD_ROW_HEIGHT }}
            >
              <WorkloadAreaChart data={w.chart} rowHeight={WORKLOAD_ROW_HEIGHT} />
            </div>
          ))}
        </div>
      </div>
    </CardShell>
  );
}

// ---------- WeldDesk ----------
const TICKET_AVATARS = ['bg-rose-500', 'bg-blue-500', 'bg-emerald-500', 'bg-amber-500', 'bg-violet-500'];
const DESK_PRIORITY: Record<string, string> = {
  urgent: 'bg-red-500',
  high: 'bg-orange-500',
  normal: 'bg-blue-500',
  low: 'bg-gray-400',
};

export type DeskTicketRow = {
  id: string;
  from: string;
  email?: string;
  avatarUrl?: string;
  subject: string;
  preview: string;
  date: Date;
  priority: string;
  unread: boolean;
};
const DEMO_TICKETS: DeskTicketRow[] = [
  { id: 'demo-t1', from: 'Sara Mertens', email: 'sara@example.com', subject: 'Invoice missing VAT line', preview: 'I noticed the latest invoice doesn\'t include the VAT breakdown…', date: demoDate(0, 9, 12), priority: 'urgent', unread: true },
  { id: 'demo-t2', from: 'Pieter Janssens', email: 'pieter@example.com', subject: 'Cannot access portal', preview: 'Login keeps redirecting me back to the SSO screen — anything you can…', date: demoDate(0, 8, 30), priority: 'high', unread: true },
  { id: 'demo-t3', from: 'Maxime Leroy', email: 'maxime@example.com', subject: 'Refund question on order 2241', preview: 'Hi! The order arrived damaged. What\'s the process to get a refund?', date: demoDate(1, 16, 5), priority: 'normal', unread: false },
  { id: 'demo-t4', from: 'Camille R.', email: 'camille@example.com', subject: 'How to export contacts?', preview: 'Quick one — is there a way to bulk-export contacts as CSV?', date: demoDate(3, 10, 22), priority: 'low', unread: false },
];

function deskRowToConversationItem(row: DeskTicketRow): ConversationItem {
  return {
    id: row.id,
    name: row.from,
    email: row.email,
    avatarUrl: row.avatarUrl,
    subject: row.subject,
    preview: row.preview,
    date: row.date,
    isRead: !row.unread,
    isStarred: false,
    hasAttachments: false,
    labels: [],
    messageCount: 1,
    unreadCount: row.unread ? 1 : 0,
  };
}

export function DeskCard({
  rows = DEMO_TICKETS,
  isLoading = false,
  isDemo = false,
}: Readonly<{ rows?: DeskTicketRow[]; isLoading?: boolean; isDemo?: boolean }> = {}) {
  if (isLoading) {
    return (
      <CardShell>
        <div className="p-3"><SkeletonRows count={5} variant="list" /></div>
      </CardShell>
    );
  }
  if (rows.length === 0) {
    return (
      <CardShell>
        <EmptyState kind="tickets" />
      </CardShell>
    );
  }
  const items = rows.map(deskRowToConversationItem);
  // Cap at 5 rows — the home card is sized to display exactly 5 tickets.
  const cappedItems = items.slice(0, 5);
  const grouped = groupByDate(cappedItems);

  return (
    <CardShell action={isDemo ? <DemoBadge /> : null}>
      <FitContent stretch>
        {Object.entries(grouped).flatMap(([dateLabel, group]) => {
          const nodes: React.ReactNode[] = [];
          if (dateLabel !== 'Today') {
            nodes.push(
              <div
                key={`header-${dateLabel}`}
                data-fit-fixed
                className="relative -mt-px flex items-center gap-2 px-3 md:px-4 h-8 bg-background border-t border-b border-border/70"
              >
                <div className="absolute inset-0 bg-muted/50 pointer-events-none" />
                <span className="relative text-xs font-medium text-muted-foreground">{dateLabel}</span>
                <span className="relative text-[10px] font-mono text-muted-foreground bg-muted border border-border w-[16px] h-[16px] flex items-center justify-center rounded-[5px] -translate-y-px">
                  <span className="translate-y-[1px]">{group.length}</span>
                </span>
              </div>,
            );
          }
          for (const item of group) {
            nodes.push(
              <ConversationListItem
                key={item.id}
                item={item}
                href={`/welddesk/inbox/${item.id}`}
                compact
              />,
            );
          }
          return nodes;
        })}
      </FitContent>
    </CardShell>
  );
}

// ---------- WeldDesk — Emails (newest support emails) ----------
export type DeskEmailRow = { from: string; initials: string; subject: string; preview: string; when: string; priority: string; unread: boolean };
const DEMO_DESK_EMAILS: DeskEmailRow[] = [
  { from: 'Sara Mertens', initials: 'S', subject: 'Re: invoice missing VAT line', preview: 'Thanks — adding the VAT breakdown now and resending the corrected invoice.', when: '09:42', priority: 'urgent', unread: true },
  { from: 'orders@example.com', initials: 'A', subject: 'Shipment delayed — order #38421', preview: 'Customs hold cleared this morning. New ETA Thursday 24th.', when: '08:55', priority: 'high', unread: true },
  { from: 'Pieter Janssens', initials: 'P', subject: 'Cannot access portal', preview: 'Login keeps redirecting me back to the SSO screen — anything you can do?', when: '08:30', priority: 'high', unread: true },
  { from: 'Maxime Leroy', initials: 'M', subject: 'Refund question on order 2241', preview: 'Hi! The order arrived damaged. What\'s the process to get a refund?', when: 'Yest', priority: 'normal', unread: false },
  { from: 'support@example.com', initials: 'V', subject: 'Webhook retries failing', preview: 'We see 502s on the /events endpoint for the last hour.', when: 'Yest', priority: 'high', unread: false },
  { from: 'Camille R.', initials: 'C', subject: 'How to export contacts?', preview: 'Quick one — is there a way to bulk-export contacts as CSV?', when: 'Mon', priority: 'low', unread: false },
];

export function DeskEmailsCard({
  rows = DEMO_DESK_EMAILS,
  isLoading = false,
  isDemo = false,
}: Readonly<{ rows?: DeskEmailRow[]; isLoading?: boolean; isDemo?: boolean }> = {}) {
  const { t } = useI18n();
  const tc = t.weldsuiteHome.cards;
  if (isLoading) {
    return <CardShell><div className="p-3"><SkeletonRows count={5} variant="list" /></div></CardShell>;
  }
  if (rows.length === 0) {
    return <CardShell><EmptyState kind="desk-emails" /></CardShell>;
  }
  return (
    <CardShell action={isDemo ? <DemoBadge /> : null}>
      <TableHeader>
        <div className="w-7" />
        <HeaderCell className="flex-1">{tc.headers.from}</HeaderCell>
        <HeaderCell className="w-[50px] text-right">{tc.headers.when}</HeaderCell>
      </TableHeader>
      {rows.map((e, i) => (
        <div key={e.subject} className={ROW_CLASS}>
          <div className="relative flex-shrink-0">
            {e.unread && (
              <div className="absolute -left-[10px] top-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full bg-blue-600" />
            )}
            <div className={cn('w-7 h-7 rounded-full flex items-center justify-center text-white font-semibold text-[11px]', TICKET_AVATARS[i % TICKET_AVATARS.length])}>
              {e.initials}
            </div>
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className={cn('h-1.5 w-1.5 rounded-full shrink-0', DESK_PRIORITY[e.priority])} />
              <div className={cn('text-sm truncate', e.unread ? 'font-semibold text-foreground' : 'text-muted-foreground')}>
                {e.from}
              </div>
            </div>
            <div className={cn('text-sm truncate', e.unread ? 'font-medium text-foreground' : 'text-foreground')}>
              {e.subject}
            </div>
            <div className="text-xs text-muted-foreground line-clamp-1">{e.preview}</div>
          </div>
          <span className="w-[50px] text-right text-xs text-muted-foreground">{e.when}</span>
        </div>
      ))}
    </CardShell>
  );
}

// ---------- WeldDesk — Live chat (newest widget conversations) ----------
export type DeskLiveChatRow = { visitor: string; initials: string; url: string; preview: string; when: string; online: boolean; unread: number; href?: string };
const DEMO_DESK_CHATS: DeskLiveChatRow[] = [
  { visitor: 'Anonymous visitor', initials: 'A', url: '/pricing', preview: 'Hi — does the Pro plan include the WMS module?', when: 'now', online: true, unread: 2 },
  { visitor: 'Lien De Smet', initials: 'L', url: '/checkout', preview: 'Stuck on payment — Stripe says 3-D secure failed.', when: '2m', online: true, unread: 1 },
  { visitor: 'Tom Hendrickx', initials: 'T', url: '/docs/api', preview: 'How do I rotate the API key?', when: '8m', online: true, unread: 1 },
  { visitor: 'Anonymous visitor', initials: 'A', url: '/features', preview: 'Can WeldFlow sync with Jira?', when: '24m', online: false, unread: 0 },
  { visitor: 'Jeroen V.', initials: 'J', url: '/contact', preview: 'Looking for a callback this afternoon.', when: '1h', online: false, unread: 0 },
  { visitor: 'Camille R.', initials: 'C', url: '/blog/release-2-1', preview: 'Where can I find the changelog?', when: '3h', online: false, unread: 0 },
];

export function DeskLiveChatCard({
  rows = DEMO_DESK_CHATS,
  isLoading = false,
  isDemo = false,
}: Readonly<{ rows?: DeskLiveChatRow[]; isLoading?: boolean; isDemo?: boolean }> = {}) {
  const { t } = useI18n();
  const tc = t.weldsuiteHome.cards;
  if (isLoading) {
    return <CardShell><div className="p-3"><SkeletonRows count={5} variant="list" /></div></CardShell>;
  }
  if (rows.length === 0) {
    return <CardShell><EmptyState kind="desk-livechat" /></CardShell>;
  }
  return (
    <CardShell action={isDemo ? <DemoBadge /> : null}>
      <TableHeader>
        <div className="w-8" />
        <HeaderCell className="flex-1">{tc.headers.visitor}</HeaderCell>
        <HeaderCell className="w-[60px] text-right">{tc.headers.when}</HeaderCell>
      </TableHeader>
      {rows.map((c, i) => {
        const row = (
        <div
          key={c.href ?? c.visitor + c.when}
          className={cn(ROW_CLASS, 'relative', c.unread > 0 && 'bg-blue-50/40 dark:bg-blue-950/20')}
        >
          {c.unread > 0 && (
            <span className="absolute left-0 top-0 bottom-0 w-0.5 bg-blue-500 rounded-r" />
          )}
          <div className="relative flex-shrink-0">
            <div className={cn('h-8 w-8 rounded-full flex items-center justify-center text-white font-semibold text-[11px]', TICKET_AVATARS[i % TICKET_AVATARS.length])}>
              {c.initials}
            </div>
            {c.online && (
              <span className="absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full bg-green-500 ring-2 ring-card" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className={cn(
                'text-sm truncate',
                c.unread > 0 ? 'font-semibold text-foreground' : 'text-foreground/90'
              )}>
                {c.visitor}
              </span>
              <span className="text-[11px] font-mono text-muted-foreground truncate">{c.url}</span>
              {c.unread > 0 && (
                <span className="inline-flex items-center justify-center h-[18px] min-w-[18px] px-1 rounded-full bg-blue-500 text-[10px] font-semibold text-white tabular-nums shrink-0">
                  {c.unread}
                </span>
              )}
            </div>
            <div className="text-xs text-muted-foreground truncate mt-0.5">{c.preview}</div>
          </div>
          <div className="w-[60px] flex-shrink-0 text-right">
            <span className="font-mono text-sm text-muted-foreground">{c.when}</span>
          </div>
        </div>
        );
        return c.href ? (
          <a key={c.href} href={c.href} className="block">
            {row}
          </a>
        ) : row;
      })}
    </CardShell>
  );
}

// ---------- WeldDesk — Slack ----------
const DESK_SLACK: Array<{ channel: string; sender: string; message: string; when: string; unread: number }> = [
  { channel: 'support-acme', sender: 'Acme · Pieter', message: 'Are you guys seeing the same 502s on /events?', when: '4m', unread: 2 },
  { channel: 'support-vinta', sender: 'Vinta · Jeroen', message: 'Quote attached, please sign off by EOD.', when: '17m', unread: 1 },
  { channel: 'cs-escalations', sender: 'Sara', message: 'Refund processed for order 2241 — case closed.', when: '52m', unread: 0 },
  { channel: 'support-lumiere', sender: 'Lumière · Marie', message: 'Domain transfer confirmed — DNS propagating now.', when: '2h', unread: 0 },
  { channel: 'support-vermeulen', sender: 'Vermeulen · Sara', message: 'Got the corrected invoice, thanks!', when: 'Yest', unread: 0 },
];

export function DeskSlackCard(_props: Readonly<{ isDemo?: boolean }> = {}) {
  const { t } = useI18n();
  const tc = t.weldsuiteHome.cards;
  return (
    <CardShell>
      <TableHeader>
        <div className="w-8" />
        <HeaderCell className="flex-1">{tc.headers.channel}</HeaderCell>
        <HeaderCell className="w-[60px] text-right">{tc.headers.when}</HeaderCell>
      </TableHeader>
      {DESK_SLACK.map((s) => (
        <div
          key={s.channel + s.when}
          className={cn(ROW_CLASS, 'relative', s.unread > 0 && 'bg-blue-50/40 dark:bg-blue-950/20')}
        >
          {s.unread > 0 && (
            <span className="absolute left-0 top-0 bottom-0 w-0.5 bg-blue-500 rounded-r" />
          )}
          <div className="h-8 w-8 rounded-[8px] bg-[#4A154B] text-white flex items-center justify-center shrink-0">
            <Slack className="h-4 w-4" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className={cn(
                'text-sm truncate',
                s.unread > 0 ? 'font-semibold text-foreground' : 'text-foreground/90'
              )}>
                #{s.channel}
              </span>
              {s.unread > 0 && (
                <span className="inline-flex items-center justify-center h-[18px] min-w-[18px] px-1 rounded-full bg-blue-500 text-[10px] font-semibold text-white tabular-nums shrink-0">
                  {s.unread}
                </span>
              )}
            </div>
            <div className="text-xs text-muted-foreground truncate mt-0.5">
              <span className="font-medium text-foreground/70">{s.sender}:</span> {s.message}
            </div>
          </div>
          <div className="w-[60px] flex-shrink-0 text-right">
            <span className="font-mono text-sm text-muted-foreground">{s.when}</span>
          </div>
        </div>
      ))}
    </CardShell>
  );
}

// ---------- WeldDesk — Discord ----------
const DESK_DISCORD: Array<{ guild: string; channel: string; sender: string; message: string; when: string; unread: number }> = [
  { guild: 'WeldSuite Community', channel: 'support', sender: 'thomas#3142', message: 'Getting CORS errors on the widget — anyone?', when: '6m', unread: 3 },
  { guild: 'WeldSuite Community', channel: 'feature-requests', sender: 'lien#9087', message: 'Would love bulk-edit on tickets!', when: '21m', unread: 1 },
  { guild: 'Acme Devs', channel: 'integrations', sender: 'pieter#1023', message: 'Webhook signing key rotated successfully.', when: '1h', unread: 0 },
  { guild: 'WeldSuite Community', channel: 'help', sender: 'maxime#7711', message: 'Where do I find the API rate-limit headers?', when: '3h', unread: 0 },
  { guild: 'Vinta Dev', channel: 'general', sender: 'jeroen#4422', message: 'Deployment looks clean from our side.', when: 'Yest', unread: 0 },
];

export function DeskDiscordCard(_props: Readonly<{ isDemo?: boolean }> = {}) {
  const { t } = useI18n();
  const tc = t.weldsuiteHome.cards;
  return (
    <CardShell>
      <TableHeader>
        <div className="w-8" />
        <HeaderCell className="flex-1">{tc.headers.channel}</HeaderCell>
        <HeaderCell className="w-[60px] text-right">{tc.headers.when}</HeaderCell>
      </TableHeader>
      {DESK_DISCORD.map((d) => (
        <div
          key={d.guild + d.channel + d.when}
          className={cn(ROW_CLASS, 'relative', d.unread > 0 && 'bg-blue-50/40 dark:bg-blue-950/20')}
        >
          {d.unread > 0 && (
            <span className="absolute left-0 top-0 bottom-0 w-0.5 bg-blue-500 rounded-r" />
          )}
          <div className="h-8 w-8 rounded-[8px] bg-[#5865F2] text-white flex items-center justify-center shrink-0">
            <MessagesSquare className="h-4 w-4" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className={cn(
                'text-sm truncate',
                d.unread > 0 ? 'font-semibold text-foreground' : 'text-foreground/90'
              )}>
                {d.guild} <span className="text-muted-foreground">·</span> #{d.channel}
              </span>
              {d.unread > 0 && (
                <span className="inline-flex items-center justify-center h-[18px] min-w-[18px] px-1 rounded-full bg-blue-500 text-[10px] font-semibold text-white tabular-nums shrink-0">
                  {d.unread}
                </span>
              )}
            </div>
            <div className="text-xs text-muted-foreground truncate mt-0.5">
              <span className="font-medium text-foreground/70">{d.sender}:</span> {d.message}
            </div>
          </div>
          <div className="w-[60px] flex-shrink-0 text-right">
            <span className="font-mono text-sm text-muted-foreground">{d.when}</span>
          </div>
        </div>
      ))}
    </CardShell>
  );
}

// ---------- WeldDesk — Active AI agent conversations ----------
export type AiAgentState = 'resolving' | 'handing-off' | 'collecting-info' | 'searching-kb' | 'awaiting-customer';

const AI_AGENT_STATE: Record<AiAgentState, { color: string; bg: string }> = {
  resolving: { color: 'text-blue-700 dark:text-blue-300', bg: 'bg-blue-100 dark:bg-blue-950' },
  'handing-off': { color: 'text-orange-700 dark:text-orange-300', bg: 'bg-orange-100 dark:bg-orange-950' },
  'collecting-info': { color: 'text-violet-700 dark:text-violet-300', bg: 'bg-violet-100 dark:bg-violet-950' },
  'searching-kb': { color: 'text-cyan-700 dark:text-cyan-300', bg: 'bg-cyan-100 dark:bg-cyan-950' },
  'awaiting-customer': { color: 'text-gray-600 dark:text-muted-foreground', bg: 'bg-gray-100 dark:bg-secondary' },
};

export type DeskAiActiveRow = { customer: string; initials: string; intent: string; state: AiAgentState; turns: number; started: string };
const DEMO_DESK_AI_ACTIVE: DeskAiActiveRow[] = [
  { customer: 'Sara Mertens', initials: 'S', intent: 'Refund on order #2241 — damaged shipment', state: 'collecting-info', turns: 4, started: '2m' },
  { customer: 'Anonymous visitor', initials: 'A', intent: 'Pricing question about Pro plan + WMS', state: 'searching-kb', turns: 2, started: '4m' },
  { customer: 'Pieter Janssens', initials: 'P', intent: 'SSO redirect loop on portal login', state: 'handing-off', turns: 6, started: '11m' },
  { customer: 'Tom Hendrickx', initials: 'T', intent: 'How to rotate API key', state: 'resolving', turns: 3, started: '18m' },
  { customer: 'Maxime Leroy', initials: 'M', intent: 'Track replacement shipment ETA', state: 'awaiting-customer', turns: 5, started: '42m' },
  { customer: 'Camille R.', initials: 'C', intent: 'Bulk-export contacts as CSV', state: 'resolving', turns: 2, started: '1h' },
];

export function DeskAiActiveCard({
  rows = DEMO_DESK_AI_ACTIVE,
  isLoading = false,
  isDemo = false,
}: Readonly<{ rows?: DeskAiActiveRow[]; isLoading?: boolean; isDemo?: boolean }> = {}) {
  const { t } = useI18n();
  const tc = t.weldsuiteHome.cards;
  if (isLoading) {
    return <CardShell><div className="p-3"><SkeletonRows count={5} variant="list" /></div></CardShell>;
  }
  if (rows.length === 0) {
    return <CardShell><EmptyState kind="desk-ai-active" /></CardShell>;
  }
  return (
    <CardShell action={isDemo ? <DemoBadge /> : null}>
      <TableHeader>
        <div className="w-8" />
        <HeaderCell className="flex-1">{tc.headers.conversation}</HeaderCell>
        <HeaderCell className="w-[110px]">{tc.headers.state}</HeaderCell>
        <HeaderCell className="w-[50px] text-right">{tc.headers.turns}</HeaderCell>
        <HeaderCell className="w-[50px] text-right">{tc.headers.started}</HeaderCell>
      </TableHeader>
      {rows.map((a, i) => {
        const state = AI_AGENT_STATE[a.state];
        return (
          <div key={a.customer + a.started} className={ROW_CLASS}>
            <div className="relative flex-shrink-0">
              <div className={cn('h-8 w-8 rounded-full flex items-center justify-center text-white font-semibold text-[11px]', TICKET_AVATARS[i % TICKET_AVATARS.length])}>
                {a.initials}
              </div>
              <span className="absolute -bottom-0.5 -right-0.5 h-[14px] w-[14px] rounded-full bg-card flex items-center justify-center">
                <Bot className="h-2.5 w-2.5 text-primary" />
              </span>
            </div>
            <div className="flex-1 min-w-0">
              <span className="text-sm font-medium text-foreground block truncate">{a.customer}</span>
              <p className="text-xs text-muted-foreground truncate">{a.intent}</p>
            </div>
            <div className="w-[110px] flex items-center">
              <span className={cn('inline-flex items-center h-[22px] px-2 rounded text-[11px] font-medium leading-none', state.color, state.bg)}>
                {tc.aiAgentState[a.state]}
              </span>
            </div>
            <div className="w-[50px] text-right">
              <span className="text-sm font-mono text-muted-foreground tabular-nums">{a.turns}</span>
            </div>
            <div className="w-[50px] text-right">
              <span className="text-sm font-mono text-muted-foreground">{a.started}</span>
            </div>
          </div>
        );
      })}
    </CardShell>
  );
}

// ---------- WeldDesk — AI agent resolved conversations ----------
type AiResolution = 'kb-article' | 'self-serve' | 'workflow' | 'escalated' | 'macro';

const AI_RESOLUTION: Record<AiResolution, { color: string; bg: string }> = {
  'kb-article': { color: 'text-cyan-700 dark:text-cyan-300', bg: 'bg-cyan-100 dark:bg-cyan-950' },
  'self-serve': { color: 'text-emerald-700 dark:text-emerald-300', bg: 'bg-emerald-100 dark:bg-emerald-950' },
  workflow: { color: 'text-violet-700 dark:text-violet-300', bg: 'bg-violet-100 dark:bg-violet-950' },
  escalated: { color: 'text-orange-700 dark:text-orange-300', bg: 'bg-orange-100 dark:bg-orange-950' },
  macro: { color: 'text-blue-700 dark:text-blue-300', bg: 'bg-blue-100 dark:bg-blue-950' },
};

export type DeskAiResolvedRow = { customer: string; initials: string; intent: string; resolution: AiResolution; csat: number | null; resolvedIn: string; when: string };
const DEMO_DESK_AI_RESOLVED: DeskAiResolvedRow[] = [
  { customer: 'Lien De Smet', initials: 'L', intent: 'How to invite a team member', resolution: 'kb-article', csat: 5, resolvedIn: '32s', when: '4m' },
  { customer: 'Anonymous visitor', initials: 'A', intent: 'Pricing for the Pro plan', resolution: 'self-serve', csat: 5, resolvedIn: '18s', when: '12m' },
  { customer: 'Tom Hendrickx', initials: 'T', intent: 'Reset 2FA without backup code', resolution: 'workflow', csat: 4, resolvedIn: '1m 8s', when: '38m' },
  { customer: 'Pieter Janssens', initials: 'P', intent: 'Bug — invoice PDF blank for EU customers', resolution: 'escalated', csat: null, resolvedIn: '2m 14s', when: '1h' },
  { customer: 'Camille R.', initials: 'C', intent: 'Where is the export button?', resolution: 'kb-article', csat: 5, resolvedIn: '22s', when: '2h' },
  { customer: 'Jeroen V.', initials: 'J', intent: 'Cancel auto-renewal on domain', resolution: 'macro', csat: 4, resolvedIn: '54s', when: 'Yest' },
];

export function DeskAiResolvedCard({
  rows = DEMO_DESK_AI_RESOLVED,
  isLoading = false,
  isDemo = false,
}: Readonly<{ rows?: DeskAiResolvedRow[]; isLoading?: boolean; isDemo?: boolean }> = {}) {
  const { t } = useI18n();
  const tc = t.weldsuiteHome.cards;
  if (isLoading) {
    return <CardShell><div className="p-3"><SkeletonRows count={5} variant="list" /></div></CardShell>;
  }
  if (rows.length === 0) {
    return <CardShell><EmptyState kind="desk-ai-resolved" /></CardShell>;
  }
  return (
    <CardShell action={isDemo ? <DemoBadge /> : null}>
      <TableHeader>
        <div className="w-8" />
        <HeaderCell className="flex-1">{tc.headers.conversation}</HeaderCell>
        <HeaderCell className="w-[100px]">{tc.headers.resolution}</HeaderCell>
        <HeaderCell className="w-[70px]">CSAT</HeaderCell>
        <HeaderCell className="w-[60px] text-right">{tc.headers.time}</HeaderCell>
        <HeaderCell className="w-[50px] text-right">{tc.headers.when}</HeaderCell>
      </TableHeader>
      {rows.map((a, i) => {
        const res = AI_RESOLUTION[a.resolution];
        return (
          <div key={a.customer + a.when} className={ROW_CLASS}>
            <div className="relative flex-shrink-0">
              <div className={cn('h-8 w-8 rounded-full flex items-center justify-center text-white font-semibold text-[11px]', TICKET_AVATARS[i % TICKET_AVATARS.length])}>
                {a.initials}
              </div>
              <span className="absolute -bottom-0.5 -right-0.5 h-[14px] w-[14px] rounded-full bg-card flex items-center justify-center">
                <CheckCircle2 className="h-2.5 w-2.5 text-emerald-500" />
              </span>
            </div>
            <div className="flex-1 min-w-0">
              <span className="text-sm font-medium text-foreground block truncate">{a.customer}</span>
              <p className="text-xs text-muted-foreground truncate">{a.intent}</p>
            </div>
            <div className="w-[100px] flex items-center">
              <span className={cn('inline-flex items-center h-[22px] px-2 rounded text-[11px] font-medium leading-none', res.color, res.bg)}>
                {tc.aiResolution[a.resolution]}
              </span>
            </div>
            <div className="w-[70px] flex items-center gap-0.5">
              {a.csat === null ? (
                <span className="text-xs text-muted-foreground">—</span>
              ) : (
                [1, 2, 3, 4, 5].map((n) => (
                  <Star
                    key={n}
                    className={cn(
                      'h-3 w-3',
                      n <= a.csat! ? 'text-yellow-500 fill-yellow-500' : 'text-gray-300 dark:text-muted-foreground/40'
                    )}
                  />
                ))
              )}
            </div>
            <div className="w-[60px] text-right">
              <span className="text-sm font-mono text-muted-foreground">{a.resolvedIn}</span>
            </div>
            <div className="w-[50px] text-right">
              <span className="text-sm font-mono text-muted-foreground">{a.when}</span>
            </div>
          </div>
        );
      })}
    </CardShell>
  );
}

// ---------- WeldDesk — Reviews ----------
export type DeskReviewRow = { customer: string; initials: string; rating: number; source: string; comment: string; when: string };
const DEMO_DESK_REVIEWS: DeskReviewRow[] = [
  { customer: 'Sara Mertens', initials: 'S', rating: 5, source: 'In-app', comment: 'Lightning-fast support — issue solved in under 10 minutes!', when: '12m' },
  { customer: 'Pieter Janssens', initials: 'P', rating: 4, source: 'Email', comment: 'Helpful, but took a couple of back-and-forths to resolve.', when: '1h' },
  { customer: 'Maxime Leroy', initials: 'M', rating: 2, source: 'Widget', comment: 'Refund process is slower than I\'d expect for damage claims.', when: '3h' },
  { customer: 'Camille R.', initials: 'C', rating: 5, source: 'In-app', comment: 'Knowledge base saved me — answered my question instantly.', when: 'Yest' },
  { customer: 'Jeroen V.', initials: 'J', rating: 5, source: 'Email', comment: 'Always responsive, always friendly. 10/10.', when: 'Yest' },
  { customer: 'Tom Hendrickx', initials: 'T', rating: 3, source: 'Widget', comment: 'Got my answer but the chat agent felt scripted.', when: 'Mon' },
];

export function DeskReviewsCard({
  rows = DEMO_DESK_REVIEWS,
  isLoading = false,
  isDemo = false,
}: Readonly<{ rows?: DeskReviewRow[]; isLoading?: boolean; isDemo?: boolean }> = {}) {
  const { t } = useI18n();
  const tc = t.weldsuiteHome.cards;
  if (isLoading) {
    return <CardShell><div className="p-3"><SkeletonRows count={5} variant="list" /></div></CardShell>;
  }
  if (rows.length === 0) {
    return <CardShell><EmptyState kind="reviews" /></CardShell>;
  }
  return (
    <CardShell action={isDemo ? <DemoBadge /> : null}>
      <TableHeader>
        <div className="w-8" />
        <HeaderCell className="flex-1">{tc.headers.customer}</HeaderCell>
        <HeaderCell className="w-[90px]">{tc.headers.rating}</HeaderCell>
        <HeaderCell className="w-[70px]">{tc.headers.source}</HeaderCell>
        <HeaderCell className="w-[50px] text-right">{tc.headers.when}</HeaderCell>
      </TableHeader>
      {rows.map((r, i) => (
        <div key={r.customer + r.when} className={ROW_CLASS}>
          <div className={cn('h-8 w-8 rounded-full flex items-center justify-center text-white font-semibold text-[11px] shrink-0', TICKET_AVATARS[i % TICKET_AVATARS.length])}>
            {r.initials}
          </div>
          <div className="flex-1 min-w-0">
            <span className="text-sm font-medium text-foreground block truncate">{r.customer}</span>
            <p className="text-xs text-muted-foreground truncate">{r.comment}</p>
          </div>
          <div className="w-[90px] flex items-center gap-0.5">
            {[1, 2, 3, 4, 5].map((n) => (
              <Star
                key={n}
                className={cn(
                  'h-3.5 w-3.5',
                  n <= r.rating ? 'text-yellow-500 fill-yellow-500' : 'text-gray-300 dark:text-muted-foreground/40'
                )}
              />
            ))}
          </div>
          <div className="w-[70px]">
            <span className="text-xs text-muted-foreground">{r.source}</span>
          </div>
          <div className="w-[50px] text-right">
            <span className="font-mono text-sm text-muted-foreground">{r.when}</span>
          </div>
        </div>
      ))}
    </CardShell>
  );
}

// ---------- WeldCRM — matches /weldcrm My Tasks row ----------
export type CrmTaskStatus = 'backlog' | 'todo' | 'in_progress' | 'review' | 'testing' | 'done' | 'cancelled';
export type CrmTaskPriority = 'low' | 'medium' | 'high';

const CRM_STATUS: Record<CrmTaskStatus, { color: string; bg: string }> = {
  backlog: { color: 'text-gray-600 dark:text-muted-foreground', bg: 'bg-gray-100 dark:bg-secondary' },
  todo: { color: 'text-gray-600 dark:text-muted-foreground', bg: 'bg-gray-100 dark:bg-secondary' },
  in_progress: { color: 'text-blue-600 dark:text-blue-400', bg: 'bg-blue-50 dark:bg-blue-950' },
  review: { color: 'text-yellow-600 dark:text-yellow-400', bg: 'bg-yellow-50 dark:bg-yellow-950' },
  testing: { color: 'text-purple-600 dark:text-purple-400', bg: 'bg-purple-50 dark:bg-purple-950' },
  done: { color: 'text-emerald-600 dark:text-emerald-400', bg: 'bg-emerald-50 dark:bg-emerald-950' },
  cancelled: { color: 'text-gray-600 dark:text-muted-foreground', bg: 'bg-gray-100 dark:bg-secondary' },
};

const CRM_PRIORITY: Record<CrmTaskPriority, { color: string; bg: string }> = {
  low: { color: 'text-gray-600 dark:text-muted-foreground', bg: 'bg-gray-100 dark:bg-secondary' },
  medium: { color: 'text-blue-600 dark:text-blue-400', bg: 'bg-blue-50 dark:bg-blue-950' },
  high: { color: 'text-orange-600 dark:text-orange-400', bg: 'bg-orange-50 dark:bg-orange-950' },
};

const CRM_COMPANY_TONE: Record<string, string> = {
  'Acme Logistics': 'bg-emerald-500',
  Vinta: 'bg-violet-500',
  'Vermeulen BV': 'bg-pink-500',
  BlueTrack: 'bg-blue-500',
  'Telia AB': 'bg-cyan-500',
  'Lumière SARL': 'bg-amber-500',
};

export type CrmTaskRow = {
  title: string;
  company: string | null;
  status: CrmTaskStatus;
  priority: CrmTaskPriority | null;
  due: string | null;
};

const DEMO_CRM_TASKS: CrmTaskRow[] = [
  { title: 'Follow up with Acme on quote', company: 'Acme Logistics', status: 'in_progress', priority: 'high', due: 'May 21' },
  { title: 'Prep demo for Vinta', company: 'Vinta', status: 'todo', priority: 'medium', due: 'May 22' },
  { title: 'Send Q2 invoicing review', company: 'Vermeulen BV', status: 'done', priority: 'medium', due: 'May 19' },
  { title: 'Schedule onboarding call', company: 'BlueTrack', status: 'todo', priority: 'low', due: 'May 24' },
  { title: 'Update pricing breakdown', company: 'Telia AB', status: 'in_progress', priority: 'medium', due: 'Today' },
  { title: 'Renewal contract — Telia', company: 'Telia AB', status: 'review', priority: 'high', due: 'May 28' },
  { title: 'Lead qualification call', company: 'Lumière SARL', status: 'testing', priority: 'medium', due: 'May 25' },
];

export function CrmCard({
  rows = DEMO_CRM_TASKS,
  isLoading = false,
  isDemo = false,
}: Readonly<{ rows?: CrmTaskRow[]; isLoading?: boolean; isDemo?: boolean }> = {}) {
  const { t } = useI18n();
  const tc = t.weldsuiteHome.cards;
  if (isLoading) {
    return <CardShell><div className="p-3"><SkeletonRows count={5} variant="table" /></div></CardShell>;
  }
  if (rows.length === 0) {
    return <CardShell><EmptyState kind="crm-tasks" /></CardShell>;
  }
  return (
    <CardShell action={isDemo ? <DemoBadge /> : null}>
      <TableHeader>
        <HeaderCell className="w-4 shrink-0 whitespace-nowrap">{tc.headers.task}</HeaderCell>
        <div className="flex-1" />
        <HeaderCell className="w-[110px]">{tc.headers.company}</HeaderCell>
        <HeaderCell className="w-[100px]">{tc.headers.status}</HeaderCell>
        <HeaderCell className="w-[80px]">{tc.headers.priority}</HeaderCell>
        <HeaderCell className="w-[60px]">{tc.headers.due}</HeaderCell>
      </TableHeader>
      {rows.map((task) => {
        const status = CRM_STATUS[task.status];
        const priority = task.priority ? CRM_PRIORITY[task.priority] : null;
        const isDone = task.status === 'done';
        const companyTone = task.company ? (CRM_COMPANY_TONE[task.company] ?? 'bg-gray-400') : 'bg-gray-400';
        return (
          <div key={task.title} className={cn(ROW_CLASS, isDone && 'opacity-50')}>
            {/* Checkbox */}
            <span
              className={cn(
                'h-4 w-4 rounded border flex items-center justify-center shrink-0',
                isDone ? 'bg-primary border-primary' : 'border-border'
              )}
            >
              {isDone && (
                <svg viewBox="0 0 24 24" className="h-3 w-3 text-primary-foreground" fill="none" stroke="currentColor" strokeWidth="3">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 12l5 5L20 7" />
                </svg>
              )}
            </span>

            {/* Title */}
            <span className={cn(
              'flex-1 min-w-0 text-sm font-medium truncate',
              isDone ? 'line-through text-gray-400' : 'text-gray-900 dark:text-foreground'
            )}>
              {task.title}
            </span>

            {/* Company — 5x5 rounded-[7px] avatar + name */}
            <div className="w-[110px] min-w-0 flex items-center gap-1.5">
              {task.company ? (
                <>
                  <div className={cn('h-5 w-5 rounded-[7px] flex items-center justify-center text-white font-medium text-[10px] shrink-0', companyTone)}>
                    {task.company.charAt(0).toUpperCase()}
                  </div>
                  <span className="text-sm text-gray-600 dark:text-muted-foreground truncate">{task.company}</span>
                </>
              ) : (
                <span className="text-sm text-gray-400">—</span>
              )}
            </div>

            {/* Status pill */}
            <div className="w-[100px]">
              <span className={cn('inline-block px-2 py-0.5 rounded text-[12px] font-medium', status.color, status.bg)}>
                {tc.crmStatus[task.status]}
              </span>
            </div>

            {/* Priority pill */}
            <div className="w-[80px]">
              {priority ? (
                <span className={cn('inline-block px-2 py-0.5 rounded text-[12px] font-medium', priority.color, priority.bg)}>
                  {task.priority && tc.crmPriority[task.priority]}
                </span>
              ) : (
                <span className="text-[12px] text-gray-400">—</span>
              )}
            </div>

            {/* Due — mono */}
            <div className="w-[60px]">
              {task.due ? (
                <span className="font-mono text-sm text-gray-600 dark:text-muted-foreground">{task.due}</span>
              ) : (
                <span className="text-sm text-gray-400">—</span>
              )}
            </div>

          </div>
        );
      })}
    </CardShell>
  );
}

// ---------- WeldCRM Pipeline — matches /weldcrm/pipeline kanban deal card ----------
export type PipelineStageId = 'lead' | 'qualified' | 'proposal' | 'negotiation';

const PIPELINE_STAGES: Array<{ id: PipelineStageId; dot: string }> = [
  { id: 'lead', dot: 'bg-gray-400' },
  { id: 'qualified', dot: 'bg-blue-500' },
  { id: 'proposal', dot: 'bg-amber-500' },
  { id: 'negotiation', dot: 'bg-orange-500' },
];

export type PipelineDealRow = {
  id?: string;
  stage: PipelineStageId;
  title: string;
  company: string;
  value: number;
  probability: number;
};

const DEMO_PIPELINE_DEALS: PipelineDealRow[] = [
  // Lead
  { stage: 'lead', title: 'BlueTrack expansion', company: 'BlueTrack', value: 24000, probability: 20 },
  { stage: 'lead', title: 'Lumière addon', company: 'Lumière SARL', value: 12000, probability: 25 },
  { stage: 'lead', title: 'Newshop migration', company: 'Newshop', value: 8500, probability: 15 },
  // Qualified
  { stage: 'qualified', title: 'Vinta SaaS deal', company: 'Vinta', value: 32500, probability: 45 },
  { stage: 'qualified', title: 'Acme platform license', company: 'Acme Logistics', value: 86000, probability: 50 },
  { stage: 'qualified', title: 'Telia rollout', company: 'Telia AB', value: 64000, probability: 55 },
  // Proposal
  { stage: 'proposal', title: 'Nordics rollout', company: 'Telia AB', value: 86000, probability: 60 },
  { stage: 'proposal', title: 'Multi-seat plan', company: 'Vermeulen BV', value: 42500, probability: 70 },
  // Negotiation
  { stage: 'negotiation', title: 'Annual renewal', company: 'Acme Logistics', value: 42500, probability: 80 },
  { stage: 'negotiation', title: 'Premium expansion', company: 'Vinta', value: 18200, probability: 85 },
];

export function PipelineCard({
  rows = DEMO_PIPELINE_DEALS,
  isLoading = false,
  isDemo = false,
}: Readonly<{ rows?: PipelineDealRow[]; isLoading?: boolean; isDemo?: boolean }> = {}) {
  const { t } = useI18n();
  const tc = t.weldsuiteHome.cards;
  if (isLoading) {
    return <CardShell><div className="p-3"><SkeletonRows variant="kanban" /></div></CardShell>;
  }
  if (rows.length === 0) {
    return <CardShell><EmptyState kind="pipeline" /></CardShell>;
  }
  return (
    <CardShell action={isDemo ? <DemoBadge /> : null}>
      <div className="flex gap-3 p-3">
        {PIPELINE_STAGES.map((stage) => {
          const stageDeals = rows.filter((d) => d.stage === stage.id);
          const stageTotal = stageDeals.reduce((sum, d) => sum + d.value, 0);
          return (
            <div
              key={stage.id}
              className="flex-1 min-w-[140px] flex flex-col gap-2 min-h-0"
            >
              {/* Stage header */}
              <div className="flex items-center justify-between gap-2 shrink-0">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className={cn('h-2 w-2 rounded-full shrink-0', stage.dot)} />
                  <span className="text-xs font-semibold text-foreground truncate">{tc.pipelineStage[stage.id]}</span>
                  <span className="text-[10px] text-muted-foreground tabular-nums">{stageDeals.length}</span>
                </div>
                <span className="text-[10px] font-mono text-muted-foreground tabular-nums shrink-0">
                  €{(stageTotal / 1000).toFixed(0)}K
                </span>
              </div>
              {/* Deal cards */}
              <div className="flex flex-col gap-2">
                {stageDeals.map((deal) => (
                  <div
                    key={deal.id ?? `${deal.company}-${deal.title}`}
                    className="bg-card rounded-md border border-gray-125 dark:border-border hover:bg-gray-50 dark:hover:bg-secondary/70 p-2 cursor-pointer transition-colors"
                  >
                    <div className="text-sm font-medium text-gray-900 dark:text-foreground truncate leading-snug">
                      {deal.title}
                    </div>
                    <div className="flex items-center gap-1 mt-1.5 min-w-0">
                      <Building2 className="h-3 w-3 text-gray-400 shrink-0" />
                      <span className="text-xs text-gray-600 dark:text-muted-foreground truncate">
                        {deal.company}
                      </span>
                    </div>
                    <div className="flex items-center justify-between mt-1.5 text-xs">
                      <span className="font-mono text-gray-700 dark:text-foreground tabular-nums">
                        €{(deal.value / 1000).toFixed(0)}K
                      </span>
                      <span className="text-gray-500 dark:text-muted-foreground tabular-nums">
                        {deal.probability}%
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </CardShell>
  );
}

// ---------- WeldCRM Sequences — matches /weldcrm/sequences row ----------
export type SequenceStatus = 'active' | 'paused' | 'draft';

const SEQ_STATUS: Record<SequenceStatus, { color: string; bg: string }> = {
  active: { color: 'text-green-600 dark:text-green-400', bg: 'bg-green-50 dark:bg-green-950' },
  paused: { color: 'text-yellow-600 dark:text-yellow-400', bg: 'bg-yellow-50 dark:bg-yellow-950' },
  draft: { color: 'text-gray-600 dark:text-muted-foreground', bg: 'bg-gray-100 dark:bg-secondary' },
};

export type SequenceRow = {
  name: string;
  description: string;
  status: SequenceStatus;
  enrolled: number;
  active: number;
  lastRun: string;
};

const DEMO_SEQUENCES: SequenceRow[] = [
  { name: 'Q3 outbound — Tech sector', description: 'Cold email to CTOs at mid-market SaaS', status: 'active', enrolled: 142, active: 38, lastRun: 'Today' },
  { name: 'Cold lead nurture', description: 'Weekly value email + case study', status: 'active', enrolled: 280, active: 96, lastRun: 'Yest' },
  { name: 'Trial onboarding', description: 'Day 0/2/7 walk-through emails', status: 'paused', enrolled: 64, active: 0, lastRun: 'May 15' },
  { name: 'Renewal reminder', description: '30/14/3 day pre-renewal touch', status: 'active', enrolled: 18, active: 12, lastRun: 'Today' },
  { name: 'Upgrade prompt — Pro', description: 'Triggers when usage > 80%', status: 'draft', enrolled: 0, active: 0, lastRun: '—' },
  { name: 'Re-engagement EU', description: '90-day inactive customers', status: 'active', enrolled: 320, active: 142, lastRun: '2h ago' },
  { name: 'Welcome series', description: 'First 14 days after signup', status: 'active', enrolled: 86, active: 8, lastRun: 'May 19' },
];

export function SequencesCard({
  rows = DEMO_SEQUENCES,
  isLoading = false,
  isDemo = false,
}: Readonly<{ rows?: SequenceRow[]; isLoading?: boolean; isDemo?: boolean }> = {}) {
  const { t, format } = useI18n();
  const tc = t.weldsuiteHome.cards;
  if (isLoading) {
    return <CardShell><div className="p-3"><SkeletonRows count={5} variant="table" /></div></CardShell>;
  }
  if (rows.length === 0) {
    return <CardShell><EmptyState kind="sequences" /></CardShell>;
  }
  return (
    <CardShell action={isDemo ? <DemoBadge /> : null}>
      <FitContent>
      <TableHeader>
        <HeaderCell className="flex-1 min-w-0">{tc.headers.sequence}</HeaderCell>
        <HeaderCell className="w-[80px]">{tc.headers.status}</HeaderCell>
        <HeaderCell className="w-[110px]">{tc.headers.enrolled}</HeaderCell>
        <HeaderCell className="w-[70px]">{tc.headers.lastRun}</HeaderCell>
      </TableHeader>
      {rows.map((seq) => {
        const status = SEQ_STATUS[seq.status];
        return (
          <div key={seq.name} className={ROW_CLASS}>
            {/* Name + description */}
            <div className="flex-1 min-w-0">
              <span className="text-sm font-medium text-gray-900 dark:text-foreground block truncate">
                {seq.name}
              </span>
              <p className="text-xs text-gray-500 dark:text-muted-foreground truncate">{seq.description}</p>
            </div>

            {/* Status pill — h-[22px] px-2 rounded text-[12px] font-medium leading-none */}
            <div className="w-[80px] flex items-center">
              <span className={cn(
                'inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none',
                status.color,
                status.bg
              )}>
                {tc.sequenceStatus[seq.status]}
              </span>
            </div>

            {/* Enrolled — count + (X active) */}
            <div className="w-[110px] flex items-center gap-1.5">
              <span className="text-sm font-mono font-medium text-gray-600 dark:text-muted-foreground tabular-nums">
                {seq.enrolled}
              </span>
              {seq.active > 0 && (
                <span className="text-xs font-mono text-green-600 dark:text-green-400 tabular-nums">
                  {format(tc.sequenceActive, { count: seq.active })}
                </span>
              )}
            </div>

            {/* Last run — mono */}
            <div className="w-[70px]">
              <span className="text-sm font-mono text-gray-500 dark:text-muted-foreground">{seq.lastRun}</span>
            </div>
          </div>
        );
      })}
      </FitContent>
    </CardShell>
  );
}

// ---------- WeldConnect — matches /weldconnect/executions table row ----------
export type ExecStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timeout';

const EXEC_STATUS_CONFIG: Record<
  ExecStatus,
  { icon: React.ComponentType<{ className?: string }>; className: string }
> = {
  queued: {
    icon: Clock,
    className: 'bg-gray-100 text-gray-800 dark:bg-secondary dark:text-muted-foreground border-gray-200 dark:border-border',
  },
  running: {
    icon: Play,
    className: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400 border-blue-200 dark:border-blue-800',
  },
  completed: {
    icon: CheckCircle2,
    className: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400 border-green-200 dark:border-green-800',
  },
  failed: {
    icon: XCircle,
    className: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400 border-red-200 dark:border-red-800',
  },
  cancelled: {
    icon: Ban,
    className: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400 border-yellow-200 dark:border-yellow-800',
  },
  timeout: {
    icon: Clock,
    className: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400 border-orange-200 dark:border-orange-800',
  },
};

const EXEC_BAR_COLOR: Record<ExecStatus, string> = {
  queued: 'bg-gray-400',
  running: 'bg-blue-500',
  completed: 'bg-green-500',
  failed: 'bg-red-500',
  cancelled: 'bg-gray-400',
  timeout: 'bg-orange-500',
};

export type ExecutionRow = {
  id: string;
  workflowName: string;
  status: ExecStatus;
  completed: number;
  total: number;
  duration: string;
  startedAgo: string;
};

const DEMO_EXECUTIONS: ExecutionRow[] = [
  { id: 'exe_8f4a1c2bd9e3', workflowName: 'Sync Stripe → invoices', status: 'completed', completed: 8, total: 8, duration: '4.2s', startedAgo: '2m ago' },
  { id: 'exe_d62fa90e7c14', workflowName: 'New ticket → Slack alert', status: 'running', completed: 3, total: 5, duration: '12.4s', startedAgo: '12m ago' },
  { id: 'exe_b91e3704a2f5', workflowName: 'Daily AP digest email', status: 'failed', completed: 2, total: 6, duration: '1.8s', startedAgo: '38m ago' },
  { id: 'exe_47c5a8d3e1b6', workflowName: 'Lead → CRM contact upsert', status: 'completed', completed: 4, total: 4, duration: '850ms', startedAgo: '1h ago' },
  { id: 'exe_2e0f4b91d8a7', workflowName: 'Domain renewal reminder', status: 'queued', completed: 0, total: 3, duration: '—', startedAgo: '2h ago' },
  { id: 'exe_91d7c2e85f3a', workflowName: 'Order confirmation → email', status: 'completed', completed: 5, total: 5, duration: '2.1s', startedAgo: '3h ago' },
  { id: 'exe_5a3f8e1b4c92', workflowName: 'Webhook retry — Stripe', status: 'cancelled', completed: 1, total: 4, duration: '6m 12s', startedAgo: 'Yest' },
];

export function ConnectCard({
  rows = DEMO_EXECUTIONS,
  isLoading = false,
  isDemo = false,
  onRowClick,
}: Readonly<{
  rows?: ExecutionRow[];
  isLoading?: boolean;
  isDemo?: boolean;
  onRowClick?: (row: ExecutionRow) => void;
}> = {}) {
  const { t } = useI18n();
  const tc = t.weldsuiteHome.cards;
  if (isLoading) {
    return <CardShell><div className="p-3"><SkeletonRows count={5} variant="table" /></div></CardShell>;
  }
  if (rows.length === 0) {
    return <CardShell><EmptyState kind="executions" /></CardShell>;
  }
  return (
    <CardShell action={isDemo ? <DemoBadge /> : null}>
      <TableHeader>
        <HeaderCell className="flex-1 min-w-0">{tc.headers.workflow}</HeaderCell>
        <HeaderCell className="w-[110px]">{tc.headers.status}</HeaderCell>
        <HeaderCell className="w-[100px]">{tc.headers.steps}</HeaderCell>
        <HeaderCell className="w-[50px] text-right">{tc.headers.duration}</HeaderCell>
        <HeaderCell className="w-[60px] text-right">{tc.headers.started}</HeaderCell>
      </TableHeader>
      {rows.map((e) => {
        const config = EXEC_STATUS_CONFIG[e.status];
        const Icon = config.icon;
        const progress = e.total > 0 ? (e.completed / e.total) * 100 : 0;
        const clickable = !!onRowClick && !!e.id;
        return (
          <ClickableRow
            key={e.id}
            className={cn(
              ROW_CLASS,
              !clickable && 'cursor-default',
              clickable && 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
            )}
            onClick={clickable ? () => onRowClick!(e) : undefined}
          >
            {/* Workflow — name + truncated id */}
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium truncate text-foreground">{e.workflowName}</div>
              <div className="text-xs text-muted-foreground truncate">
                ID: {e.id.slice(0, 8)}...
              </div>
            </div>

            {/* Status — outline badge with icon + label */}
            <div className="w-[110px]">
              <span
                className={cn(
                  'inline-flex items-center h-[22px] px-2 rounded border text-[11px] font-medium leading-none',
                  config.className
                )}
              >
                <Icon className={cn('h-3 w-3 mr-1', e.status === 'running' && 'animate-spin')} />
                {tc.execStatus[e.status]}
              </span>
            </div>

            {/* Steps — "X/Y" + 16px progress bar (h-1.5) */}
            <div className="w-[100px] flex items-center gap-2">
              <span className="text-sm tabular-nums">
                {e.completed}/{e.total}
              </span>
              <div className="w-16 h-1.5 bg-gray-200 dark:bg-accent rounded-full overflow-hidden">
                <div
                  className={cn('h-full transition-all', EXEC_BAR_COLOR[e.status])}
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>

            {/* Duration — mono */}
            <div className="w-[50px] text-right">
              <span className="font-mono text-sm text-foreground">{e.duration}</span>
            </div>

            {/* Started — relative */}
            <div className="w-[60px] text-right">
              <span className="text-sm text-muted-foreground">{e.startedAgo}</span>
            </div>
          </ClickableRow>
        );
      })}
    </CardShell>
  );
}

// ---------- WeldConnect — Workflows (matches /weldconnect/workflows table) ----------
export type WorkflowStatus = 'active' | 'paused' | 'draft';
export type TriggerType = 'webhook' | 'schedule' | 'manual';

const WORKFLOW_STATUS: Record<WorkflowStatus, { icon: React.ComponentType<{ className?: string }>; color: string; bg: string }> = {
  active: { icon: Play, color: 'text-green-700 dark:text-green-400', bg: 'bg-green-100 dark:bg-green-950' },
  paused: { icon: Pause, color: 'text-orange-700 dark:text-orange-400', bg: 'bg-orange-100 dark:bg-orange-950' },
  draft: { icon: FileText, color: 'text-gray-600 dark:text-muted-foreground', bg: 'bg-gray-100 dark:bg-secondary' },
};

const TRIGGER_ICON: Record<TriggerType, React.ComponentType<{ className?: string }>> = {
  webhook: Webhook,
  schedule: Calendar,
  manual: Activity,
};

export type WorkflowRow = {
  id?: string;
  name: string;
  description: string;
  trigger: TriggerType;
  steps: number;
  executions: number;
  successRate: number;
  status: WorkflowStatus;
};

const DEMO_WORKFLOWS: WorkflowRow[] = [
  { name: 'Sync Stripe → invoices', description: 'Mirror Stripe charges into WeldBooks as paid invoices', trigger: 'webhook', steps: 8, executions: 1248, successRate: 98, status: 'active' },
  { name: 'Lead → CRM contact upsert', description: 'Create or update a CRM contact from new website leads', trigger: 'webhook', steps: 4, executions: 856, successRate: 96, status: 'active' },
  { name: 'Daily AP digest email', description: 'Send a digest of open bills + due dates every morning', trigger: 'schedule', steps: 6, executions: 124, successRate: 100, status: 'active' },
  { name: 'New ticket → Slack alert', description: 'Notify #support when a new high-priority ticket lands', trigger: 'webhook', steps: 5, executions: 421, successRate: 92, status: 'active' },
  { name: 'Order confirmation → email', description: 'Send branded confirmation email on new commerce order', trigger: 'webhook', steps: 5, executions: 1892, successRate: 88, status: 'paused' },
  { name: 'Domain renewal reminder', description: 'Email customers 30 days before their domain expires', trigger: 'schedule', steps: 3, executions: 18, successRate: 100, status: 'active' },
  { name: 'Welcome email sequence', description: 'Three-step onboarding sequence for new signups', trigger: 'manual', steps: 4, executions: 0, successRate: 0, status: 'draft' },
];

export function WorkflowsCard({
  rows = DEMO_WORKFLOWS,
  isLoading = false,
  isDemo = false,
  onRowClick,
}: Readonly<{
  rows?: WorkflowRow[];
  isLoading?: boolean;
  isDemo?: boolean;
  onRowClick?: (row: WorkflowRow) => void;
}> = {}) {
  const { t } = useI18n();
  const tc = t.weldsuiteHome.cards;
  if (isLoading) {
    return <CardShell><div className="p-3"><SkeletonRows count={5} variant="table" /></div></CardShell>;
  }
  if (rows.length === 0) {
    return <CardShell><EmptyState kind="workflows" /></CardShell>;
  }
  return (
    <CardShell action={isDemo ? <DemoBadge /> : null}>
      <TableHeader>
        <HeaderCell className="flex-1 min-w-0">{tc.headers.workflow}</HeaderCell>
        <HeaderCell className="w-[100px]">{tc.headers.trigger}</HeaderCell>
        <HeaderCell className="w-[50px] text-right">{tc.headers.steps}</HeaderCell>
        <HeaderCell className="w-[80px] text-right">{tc.headers.runs}</HeaderCell>
        <HeaderCell className="w-[80px]">{tc.headers.status}</HeaderCell>
      </TableHeader>
      {rows.map((w) => {
        const status = WORKFLOW_STATUS[w.status];
        const StatusIcon = status.icon;
        const TrigIcon = TRIGGER_ICON[w.trigger];
        const rowKey = w.id ?? w.name;
        const clickable = !!onRowClick && !!w.id;
        let rateColor = 'text-red-600 dark:text-red-400';
        if (w.executions === 0) {
          rateColor = 'text-muted-foreground';
        } else if (w.successRate >= 90) {
          rateColor = 'text-green-600 dark:text-green-400';
        } else if (w.successRate >= 70) {
          rateColor = 'text-yellow-600 dark:text-yellow-400';
        }
        return (
          <ClickableRow
            key={rowKey}
            className={cn(
              ROW_CLASS,
              !clickable && 'cursor-default',
              clickable && 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
            )}
            onClick={clickable ? () => onRowClick!(w) : undefined}
          >
            {/* Name + description */}
            <div className="flex-1 min-w-0">
              <span className="text-sm font-medium text-gray-900 dark:text-foreground block truncate">
                {w.name}
              </span>
              <span className="block text-xs text-gray-500 dark:text-muted-foreground truncate">{w.description}</span>
            </div>

            {/* Trigger — icon + label */}
            <div className="w-[100px] flex items-center gap-1.5">
              <TrigIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <span className="text-sm text-foreground truncate">{tc.trigger[w.trigger]}</span>
            </div>

            {/* Steps — number, right aligned */}
            <div className="w-[50px] text-right">
              <span className="text-sm font-mono font-medium text-gray-600 dark:text-muted-foreground tabular-nums">{w.steps}</span>
            </div>

            {/* Runs — execution count + success rate */}
            <div className="w-[80px] text-right">
              <div className="text-sm font-mono font-medium text-gray-600 dark:text-muted-foreground tabular-nums">
                {w.executions.toLocaleString()}
              </div>
              {w.executions > 0 && (
                <div className={cn('text-xs font-mono tabular-nums', rateColor)}>{w.successRate}%</div>
              )}
            </div>

            {/* Status pill */}
            <div className="w-[80px] flex items-center">
              <span
                className={cn(
                  'inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none gap-1',
                  status.color,
                  status.bg
                )}
              >
                <StatusIcon className="h-3 w-3" />
                {tc.workflowStatus[w.status]}
              </span>
            </div>
          </ClickableRow>
        );
      })}
    </CardShell>
  );
}

// ---------- WeldMeet ----------
export type MeetingRow = { time: string; title: string; duration: string; attendees: number; status: string };
const DEMO_MEETINGS: MeetingRow[] = [
  { time: '10:00', title: 'Weekly leadership sync', duration: '60m', attendees: 6, status: 'upcoming' },
  { time: '11:30', title: 'Demo — Acme Logistics', duration: '30m', attendees: 3, status: 'upcoming' },
  { time: '14:00', title: '1:1 with Lien', duration: '30m', attendees: 2, status: 'upcoming' },
  { time: '16:00', title: 'Roadmap planning Q3', duration: '90m', attendees: 8, status: 'upcoming' },
  { time: 'Yest 16:00', title: 'Customer interview — BlueTrack', duration: '45m', attendees: 4, status: 'recorded' },
];

export function MeetCard({
  rows = DEMO_MEETINGS,
  isLoading = false,
  isDemo = false,
}: Readonly<{ rows?: MeetingRow[]; isLoading?: boolean; isDemo?: boolean }> = {}) {
  const { t } = useI18n();
  const tc = t.weldsuiteHome.cards;
  if (isLoading) {
    return <CardShell><div className="p-3"><SkeletonRows count={5} variant="table" /></div></CardShell>;
  }
  if (rows.length === 0) {
    return <CardShell><EmptyState kind="meetings" /></CardShell>;
  }
  return (
    <CardShell action={isDemo ? <DemoBadge /> : null}>
      <TableHeader>
        <HeaderCell className="w-[90px]">{tc.headers.when}</HeaderCell>
        <HeaderCell className="flex-1">{tc.headers.title}</HeaderCell>
        <HeaderCell className="w-[50px] text-right">{tc.headers.duration}</HeaderCell>
        <HeaderCell className="w-[40px] text-right">{tc.headers.attendeesShort}</HeaderCell>
      </TableHeader>
      {rows.map((m) => (
        <div key={m.title} className={ROW_CLASS}>
          <div className="w-[90px] text-xs text-muted-foreground tabular-nums truncate">{m.time}</div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-foreground truncate">{m.title}</div>
            <div className="text-[11px] text-muted-foreground ">{tc.meetStatus[m.status as keyof typeof tc.meetStatus] ?? m.status}</div>
          </div>
          <div className="w-[50px] text-right text-xs text-muted-foreground tabular-nums">{m.duration}</div>
          <div className="w-[40px] text-right text-xs text-muted-foreground">{m.attendees}</div>
        </div>
      ))}
    </CardShell>
  );
}

// ---------- WeldMeet History — matches /weldmeet/history row ----------
const MEET_TYPE: Record<'video' | 'audio', { icon: React.ComponentType<{ className?: string }>; color: string }> = {
  video: { icon: Video, color: 'text-blue-600 dark:text-blue-400' },
  audio: { icon: Phone, color: 'text-purple-600 dark:text-purple-400' },
};

export type MeetingHistoryRow = {
  title: string;
  type: 'video' | 'audio';
  date: string;
  participants: string[];
  totalParticipants: number;
  duration: string;
  recorded: boolean;
};

/** The first three participants show as stacked avatars, one per slot. */
const PARTICIPANT_AVATAR_SLOTS = [0, 1, 2];

const DEMO_MEETING_HISTORY: MeetingHistoryRow[] = [
  { title: 'Weekly leadership sync', type: 'video', date: 'Today, 10:00 AM', participants: ['L', 'T', 'S'], totalParticipants: 6, duration: '58m 12s', recorded: true },
  { title: 'Demo — Acme Logistics', type: 'video', date: 'Today, 11:30 AM', participants: ['S', 'A', 'T'], totalParticipants: 3, duration: '32m 04s', recorded: true },
  { title: 'Sales call — BlueTrack', type: 'audio', date: 'Yest, 4:00 PM', participants: ['J', 'B', 'M'], totalParticipants: 3, duration: '24m 18s', recorded: false },
  { title: 'Customer interview — Vinta', type: 'video', date: 'Yest, 2:30 PM', participants: ['T', 'V'], totalParticipants: 2, duration: '45m 50s', recorded: true },
  { title: '1:1 with Lien', type: 'video', date: 'May 18', participants: ['G', 'L'], totalParticipants: 2, duration: '28m 36s', recorded: false },
  { title: 'Q3 roadmap planning', type: 'video', date: 'May 17', participants: ['L', 'T', 'S'], totalParticipants: 8, duration: '1h 42m', recorded: true },
  { title: 'Quick sync — Camille', type: 'audio', date: 'May 16', participants: ['C', 'G'], totalParticipants: 2, duration: '8m 42s', recorded: false },
];

export function MeetHistoryCard({
  rows = DEMO_MEETING_HISTORY,
  isLoading = false,
  isDemo = false,
}: Readonly<{ rows?: MeetingHistoryRow[]; isLoading?: boolean; isDemo?: boolean }> = {}) {
  const { t } = useI18n();
  const tc = t.weldsuiteHome.cards;
  if (isLoading) {
    return <CardShell><div className="p-3"><SkeletonRows count={5} variant="table" /></div></CardShell>;
  }
  if (rows.length === 0) {
    return <CardShell><EmptyState kind="meet-history" /></CardShell>;
  }
  return (
    <CardShell action={isDemo ? <DemoBadge /> : null}>
      <FitContent>
        <TableHeader>
          <HeaderCell className="flex-1 min-w-0">{tc.headers.meeting}</HeaderCell>
          <HeaderCell className="w-[130px]">{tc.headers.date}</HeaderCell>
          <HeaderCell className="w-[100px]">{tc.headers.participants}</HeaderCell>
          <HeaderCell className="w-[70px]">{tc.headers.duration}</HeaderCell>
        </TableHeader>
        {rows.map((m) => {
          const type = MEET_TYPE[m.type];
          const TypeIcon = type.icon;
          return (
            <div key={m.title + m.date} className={ROW_CLASS}>
            {/* Meeting — type icon + title + recorded indicator */}
            <div className="flex-1 min-w-0 flex items-center gap-2">
              <TypeIcon className={cn('h-4 w-4 shrink-0', type.color)} />
              <span className="text-sm font-medium truncate text-foreground">{m.title}</span>
              {m.recorded && (
                <span className="flex items-center gap-1 px-2 py-[3px] rounded-[6px] text-[11px] font-medium bg-red-50 dark:bg-red-950 text-red-600 dark:text-red-400 shrink-0">
                  <div className="h-1.5 w-1.5 rounded-full bg-red-500" />
                  {tc.meetRecorded}
                </span>
              )}
            </div>

            {/* Date — mono */}
            <div className="w-[130px]">
              <span className="text-sm font-mono text-gray-600 dark:text-muted-foreground truncate block">
                {m.date}
              </span>
            </div>

            {/* Participants — stacked avatars with +N */}
            <div className="w-[100px]">
              <div className="flex -space-x-1.5">
                {PARTICIPANT_AVATAR_SLOTS.slice(0, m.participants.length).map((slot) => (
                  <div
                    key={slot}
                    className="w-[23px] h-[23px] rounded-md bg-gray-200 dark:bg-accent flex items-center justify-center ring-2 ring-card"
                  >
                    <span className="text-[10px] font-medium text-gray-600 dark:text-muted-foreground">
                      {m.participants[slot]}
                    </span>
                  </div>
                ))}
                {m.totalParticipants > 3 && (
                  <div className="w-[23px] h-[23px] rounded-md bg-gray-200 dark:bg-accent flex items-center justify-center ring-2 ring-card">
                    <span className="text-[11px] font-semibold text-gray-600 dark:text-muted-foreground">
                      +{m.totalParticipants - 3}
                    </span>
                  </div>
                )}
              </div>
            </div>

            {/* Duration — mono */}
            <div className="w-[70px]">
              <span className="text-sm font-mono text-muted-foreground">{m.duration}</span>
            </div>
            </div>
          );
        })}
      </FitContent>
    </CardShell>
  );
}

// ---------- WeldChat — matches /weldchat/activity row design ----------
type ActivityCategory = 'mentions' | 'replies' | 'dms' | 'other';

const CATEGORY_ICONS: Record<ActivityCategory, React.ComponentType<{ className?: string }>> = {
  mentions: AtSign,
  replies: Reply,
  dms: MessageCircle,
  other: User,
};

const CHAT_AVATARS = ['bg-blue-500', 'bg-emerald-500', 'bg-violet-500', 'bg-amber-500', 'bg-rose-500', 'bg-cyan-500', 'bg-rose-500'];

export type ChatActivityRow = {
  actor: string;
  initials: string;
  category: ActivityCategory;
  title: string;
  body?: string;
  channel?: string;
  when: string;
  unread: boolean;
};

type HomeStrings = ReturnType<typeof useI18n>['t']['weldsuiteHome'];
type FormatFn = ReturnType<typeof useI18n>['format'];

function buildDemoActivity(h: HomeStrings, format: FormatFn): ChatActivityRow[] {
  const d = h.cards.chatDemo.activity;
  const tm = h.time;
  return [
    { actor: 'Lien De Smet', initials: 'L', category: 'mentions', title: d.reviewPricing.title, body: d.reviewPricing.body, channel: 'product-launch', when: format(tm.minutesAgo, { count: 12 }), unread: true },
    { actor: 'Sara Mertens', initials: 'S', category: 'replies', title: d.correctedInvoice.title, body: d.correctedInvoice.body, channel: 'support-escalations', when: format(tm.minutesAgo, { count: 38 }), unread: true },
    { actor: 'Tom Hendrickx', initials: 'T', category: 'dms', title: d.vpnDm.title, body: d.vpnDm.body, when: format(tm.hoursAgo, { count: 1 }), unread: true },
    { actor: 'Jeroen V.', initials: 'J', category: 'mentions', title: d.supplierQuote.title, body: d.supplierQuote.body, channel: 'sales', when: format(tm.hoursAgo, { count: 2 }), unread: false },
    { actor: 'Camille R.', initials: 'C', category: 'replies', title: d.onboardingThread.title, body: d.onboardingThread.body, channel: 'design', when: format(tm.hoursAgo, { count: 4 }), unread: false },
    { actor: 'Pieter J.', initials: 'P', category: 'mentions', title: d.deploymentNotes.title, body: d.deploymentNotes.body, channel: 'devops', when: tm.yesterdayShort, unread: false },
    { actor: 'Maxime L.', initials: 'M', category: 'dms', title: d.syncDm.title, body: d.syncDm.body, when: format(tm.daysAgo, { count: 2 }), unread: false },
  ];
}

export function ChatCard({
  rows: rowsProp,
  isLoading = false,
  isDemo = false,
}: Readonly<{ rows?: ChatActivityRow[]; isLoading?: boolean; isDemo?: boolean }> = {}) {
  const { t, format } = useI18n();
  const tc = t.weldsuiteHome.cards;
  const rows = rowsProp ?? buildDemoActivity(t.weldsuiteHome, format);
  if (isLoading) {
    return <CardShell><div className="p-3"><SkeletonRows count={5} variant="list" /></div></CardShell>;
  }
  if (rows.length === 0) {
    return <CardShell><EmptyState kind="chat-activity" /></CardShell>;
  }
  return (
    <CardShell action={isDemo ? <DemoBadge /> : null}>
      <TableHeader>
        <HeaderCell className="flex-1 min-w-0">{tc.headers.activity}</HeaderCell>
        <HeaderCell className="w-[140px]">{tc.headers.channel}</HeaderCell>
        <HeaderCell className="w-[80px]">{tc.headers.when}</HeaderCell>
      </TableHeader>
      {rows.map((a, i) => {
        const Icon = CATEGORY_ICONS[a.category];
        return (
          <div
            key={`${a.actor}-${a.when}-${a.title}`}
            className={cn(ROW_CLASS, 'relative', a.unread && 'bg-blue-50/40 dark:bg-blue-950/20')}
          >
            {a.unread && (
              <span className="absolute left-0 top-0 bottom-0 w-0.5 bg-blue-500 rounded-r" />
            )}

            {/* Activity — avatar with category-icon badge + title (with inline "in #channel") + body */}
            <div className="flex-1 min-w-0 flex items-center gap-3">
              <div className="relative flex-shrink-0">
                <div className={cn('h-6 w-6 rounded-[8px] flex items-center justify-center text-white font-medium text-[10px]', CHAT_AVATARS[i % CHAT_AVATARS.length])}>
                  {a.initials}
                </div>
                <span className="absolute -bottom-0.5 -right-0.5 h-[12px] w-[12px] rounded-full bg-background flex items-center justify-center">
                  <Icon className="h-2.5 w-2.5 text-foreground" />
                </span>
              </div>
              <div className="min-w-0 flex-1">
                <div className={cn(
                  'text-sm leading-snug truncate',
                  a.unread ? 'font-semibold text-foreground' : 'text-foreground/80'
                )}>
                  {a.title}
                  {a.channel && (
                    <span className="font-normal text-muted-foreground"> {format(tc.chatInChannel, { channel: a.channel })}</span>
                  )}
                </div>
                {a.body && (
                  <div className="text-xs text-muted-foreground truncate mt-0.5">{a.body}</div>
                )}
              </div>
            </div>

            {/* Channel column */}
            <div className="w-[140px] flex-shrink-0">
              {a.channel ? (
                <span className="text-sm text-gray-600 dark:text-muted-foreground truncate block">
                  #{a.channel}
                </span>
              ) : (
                <span className="text-sm text-gray-400">—</span>
              )}
            </div>

            {/* When column — mono */}
            <div className="w-[80px] flex-shrink-0">
              <span className="font-mono text-sm text-gray-600 dark:text-muted-foreground">
                {a.when}
              </span>
            </div>
          </div>
        );
      })}
    </CardShell>
  );
}


// ---------- WeldChat — Direct messages (people) ----------
export type DmRow = { name: string; initials: string; preview: string; when: string; unread: number; online: boolean };
function buildDemoDms(h: HomeStrings, format: FormatFn): DmRow[] {
  const d = h.cards.chatDemo.dms;
  const tm = h.time;
  const wd = h.cards.calendar.weekdays;
  return [
    { name: 'Lien De Smet', initials: 'L', preview: d.deployDone, when: format(tm.minutesShort, { count: 5 }), unread: 2, online: true },
    { name: 'Tom Hendrickx', initials: 'T', preview: d.vpnConfig, when: format(tm.minutesShort, { count: 32 }), unread: 1, online: true },
    { name: 'Sara Mertens', initials: 'S', preview: d.correctedInvoice, when: format(tm.hoursShort, { count: 1 }), unread: 0, online: false },
    { name: 'Maxime L.', initials: 'M', preview: d.wednesday, when: format(tm.hoursShort, { count: 3 }), unread: 0, online: true },
    { name: 'Jeroen V.', initials: 'J', preview: d.acmeQuote, when: tm.yesterdayShort, unread: 0, online: false },
    { name: 'Camille R.', initials: 'C', preview: d.figmaPass, when: wd.mon, unread: 0, online: false },
    { name: 'Pieter J.', initials: 'P', preview: d.deployNotes, when: wd.sun, unread: 0, online: false },
  ];
}

export function ChatDMsCard({
  rows: rowsProp,
  isLoading = false,
  isDemo = false,
}: Readonly<{ rows?: DmRow[]; isLoading?: boolean; isDemo?: boolean }> = {}) {
  const { t, format } = useI18n();
  const tc = t.weldsuiteHome.cards;
  const rows = rowsProp ?? buildDemoDms(t.weldsuiteHome, format);
  if (isLoading) {
    return <CardShell><div className="p-3"><SkeletonRows count={5} variant="list" /></div></CardShell>;
  }
  if (rows.length === 0) {
    return <CardShell><EmptyState kind="chat-dms" /></CardShell>;
  }
  return (
    <CardShell action={isDemo ? <DemoBadge /> : null}>
      <TableHeader>
        <HeaderCell className="flex-1 min-w-0">{tc.headers.person}</HeaderCell>
        <HeaderCell className="w-[60px] text-right">{tc.headers.when}</HeaderCell>
      </TableHeader>
      {rows.map((dm, i) => (
        <div
          key={dm.name}
          className={cn(ROW_CLASS, 'relative', dm.unread > 0 && 'bg-blue-50/40 dark:bg-blue-950/20')}
        >
          {dm.unread > 0 && (
            <span className="absolute left-0 top-0 bottom-0 w-0.5 bg-blue-500 rounded-r" />
          )}

          <div className="flex-1 min-w-0 flex items-center gap-3">
            <div className="relative flex-shrink-0">
              <div className={cn('h-8 w-8 rounded-full flex items-center justify-center text-white font-medium text-xs', CHAT_AVATARS[i % CHAT_AVATARS.length])}>
                {dm.initials}
              </div>
              {dm.online && (
                <span className="absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full bg-green-500 ring-2 ring-card" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className={cn(
                  'text-sm truncate',
                  dm.unread > 0 ? 'font-semibold text-foreground' : 'text-foreground/90'
                )}>
                  {dm.name}
                </span>
                {dm.unread > 0 && (
                  <span className="inline-flex items-center justify-center h-[18px] min-w-[18px] px-1 rounded-full bg-blue-500 text-[10px] font-semibold text-white tabular-nums shrink-0">
                    {dm.unread}
                  </span>
                )}
              </div>
              <div className="text-xs text-muted-foreground truncate mt-0.5">{dm.preview}</div>
            </div>
          </div>

          <div className="w-[60px] flex-shrink-0 text-right">
            <span className="font-mono text-sm text-muted-foreground">{dm.when}</span>
          </div>
        </div>
      ))}
    </CardShell>
  );
}

// ---------- WeldChat — Channels ----------
export type ChannelRow = { name: string; sender: string; message: string; when: string; unread: number; members: number };
const DEMO_CHANNELS: ChannelRow[] = [
  { name: 'product-launch', sender: 'Lien', message: '@gert can you review the pricing page tonight?', when: '12m', unread: 3, members: 12 },
  { name: 'support-escalations', sender: 'Sara', message: 'Yes — Vermeulen got the corrected invoice this morning.', when: '38m', unread: 1, members: 6 },
  { name: 'sales', sender: 'Jeroen', message: '@gert supplier quote needs your sign-off by EOD.', when: '2h', unread: 0, members: 8 },
  { name: 'design', sender: 'Camille', message: 'Updated the Figma file with feedback from yesterday.', when: '4h', unread: 0, members: 5 },
  { name: 'devops', sender: 'Pieter', message: 'Production deploy at 22:00 CET — heads up.', when: 'Yest', unread: 0, members: 4 },
  { name: 'general', sender: 'Anne', message: 'Coffee break at 15:00 today!', when: 'Mon', unread: 0, members: 24 },
  { name: 'random', sender: 'Tom', message: 'Anyone else having issues with the VPN?', when: 'Sun', unread: 0, members: 18 },
];

export function ChatChannelsCard({
  rows = DEMO_CHANNELS,
  isLoading = false,
  isDemo = false,
}: Readonly<{ rows?: ChannelRow[]; isLoading?: boolean; isDemo?: boolean }> = {}) {
  const { t } = useI18n();
  const tc = t.weldsuiteHome.cards;
  if (isLoading) {
    return <CardShell><div className="p-3"><SkeletonRows count={5} variant="list" /></div></CardShell>;
  }
  if (rows.length === 0) {
    return <CardShell><EmptyState kind="chat-channels" /></CardShell>;
  }
  return (
    <CardShell action={isDemo ? <DemoBadge /> : null}>
      <TableHeader>
        <HeaderCell className="flex-1 min-w-0">{tc.headers.channel}</HeaderCell>
        <HeaderCell className="w-[60px] text-right">{tc.headers.when}</HeaderCell>
      </TableHeader>
      {rows.map((ch) => (
        <div
          key={ch.name}
          className={cn(ROW_CLASS, 'relative', ch.unread > 0 && 'bg-blue-50/40 dark:bg-blue-950/20')}
        >
          {ch.unread > 0 && (
            <span className="absolute left-0 top-0 bottom-0 w-0.5 bg-blue-500 rounded-r" />
          )}

          <div className="flex-1 min-w-0 flex items-center gap-3">
            <div className="h-8 w-8 rounded-[8px] bg-muted flex items-center justify-center text-muted-foreground shrink-0">
              <Hash className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className={cn(
                  'text-sm truncate',
                  ch.unread > 0 ? 'font-semibold text-foreground' : 'text-foreground/90'
                )}>
                  #{ch.name}
                </span>
                {ch.unread > 0 && (
                  <span className="inline-flex items-center justify-center h-[18px] min-w-[18px] px-1 rounded-full bg-blue-500 text-[10px] font-semibold text-white tabular-nums shrink-0">
                    {ch.unread}
                  </span>
                )}
              </div>
              <div className="text-xs text-muted-foreground truncate mt-0.5">
                <span className="font-medium text-foreground/70">{ch.sender}:</span> {ch.message}
              </div>
            </div>
          </div>

          <div className="w-[60px] flex-shrink-0 text-right">
            <span className="font-mono text-sm text-muted-foreground">{ch.when}</span>
          </div>
        </div>
      ))}
    </CardShell>
  );
}

// ---------- WeldHost ----------
const DOMAIN_STATUS: Record<'active' | 'pending' | 'expiring', { color: string; bg: string }> = {
  active: { color: 'text-emerald-700 dark:text-emerald-300', bg: 'bg-emerald-100 dark:bg-emerald-900/40' },
  pending: { color: 'text-blue-700 dark:text-blue-300', bg: 'bg-blue-100 dark:bg-blue-900/40' },
  expiring: { color: 'text-red-700 dark:text-red-300', bg: 'bg-red-100 dark:bg-red-900/40' },
};

export type DomainRow = { name: string; status: 'active' | 'pending' | 'expiring'; expires: string; registrar: string };
const DEMO_DOMAINS: DomainRow[] = [
  { name: 'weldsuite.com', status: 'expiring', expires: 'Jun 01', registrar: 'WeldSuite' },
  { name: 'acmelogistics.eu', status: 'active', expires: 'Jun 17', registrar: 'GoDaddy' },
  { name: 'lumiere.fr', status: 'active', expires: 'Jul 23', registrar: 'Gandi' },
  { name: 'northwind.io', status: 'active', expires: 'Nov 16', registrar: 'WeldSuite' },
  { name: 'newshop.be', status: 'pending', expires: '—', registrar: 'WeldSuite' },
];

export function HostCard({
  rows = DEMO_DOMAINS,
  isLoading = false,
  isDemo = false,
}: Readonly<{ rows?: DomainRow[]; isLoading?: boolean; isDemo?: boolean }> = {}) {
  const { t } = useI18n();
  const tc = t.weldsuiteHome.cards;
  if (isLoading) {
    return <CardShell><div className="p-3"><SkeletonRows count={5} variant="table" /></div></CardShell>;
  }
  if (rows.length === 0) {
    return <CardShell><EmptyState kind="domains" /></CardShell>;
  }
  return (
    <CardShell action={isDemo ? <DemoBadge /> : null}>
      <TableHeader>
        <HeaderCell className="flex-1">{tc.headers.domain}</HeaderCell>
        <HeaderCell className="w-[70px]">{tc.headers.status}</HeaderCell>
        <HeaderCell className="w-[70px]">{tc.headers.expires}</HeaderCell>
        <HeaderCell className="w-[80px]">{tc.headers.registrar}</HeaderCell>
      </TableHeader>
      {rows.map((d) => {
        const s = DOMAIN_STATUS[d.status];
        return (
          <div key={d.name} className={ROW_CLASS}>
            <div className="flex-1 min-w-0 flex items-center gap-2">
              <Globe className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <span className="text-sm text-foreground truncate">{d.name}</span>
            </div>
            <div className="w-[70px]">
              <span className={cn('inline-block text-[11px] font-medium rounded px-2 py-0.5', s.color, s.bg)}>{tc.domainStatus[d.status]}</span>
            </div>
            <div className="w-[70px] text-xs text-muted-foreground">{d.expires}</div>
            <div className="w-[80px] text-xs text-muted-foreground truncate">{d.registrar}</div>
          </div>
        );
      })}
    </CardShell>
  );
}

// ---------- WeldDrive ----------
const FILE_ICON_TONE: Record<string, string> = {
  xlsx: 'text-emerald-500',
  pdf: 'text-red-500',
  pptx: 'text-orange-500',
  docx: 'text-blue-500',
  png: 'text-violet-500',
  default: 'text-muted-foreground',
};

export type FileRow = { name: string; ext: string; size: string; author: string; when: string };
const DEMO_FILES: FileRow[] = [
  { name: 'Q2 budget — final', ext: 'xlsx', size: '124 KB', author: 'Lien', when: '12m ago' },
  { name: 'Brand guidelines v3', ext: 'pdf', size: '4.2 MB', author: 'Tom', when: '1h ago' },
  { name: 'Onboarding deck', ext: 'pptx', size: '8.6 MB', author: 'Sara', when: 'Yest' },
  { name: 'Supplier contract — Acme', ext: 'pdf', size: '320 KB', author: 'Jeroen', when: '2d' },
  { name: 'Logo set', ext: 'png', size: '1.8 MB', author: 'Tom', when: '3d' },
];

export function DriveCard({
  rows = DEMO_FILES,
  isLoading = false,
  isDemo = false,
}: Readonly<{ rows?: FileRow[]; isLoading?: boolean; isDemo?: boolean }> = {}) {
  const { t } = useI18n();
  const tc = t.weldsuiteHome.cards;
  if (isLoading) {
    return <CardShell><div className="p-3"><SkeletonRows count={5} variant="table" /></div></CardShell>;
  }
  if (rows.length === 0) {
    return <CardShell><EmptyState kind="files" /></CardShell>;
  }
  return (
    <CardShell action={isDemo ? <DemoBadge /> : null}>
      <TableHeader>
        <HeaderCell className="flex-1">{tc.headers.name}</HeaderCell>
        <HeaderCell className="w-[60px]">{tc.headers.size}</HeaderCell>
        <HeaderCell className="w-[80px]">{tc.headers.modifiedBy}</HeaderCell>
        <HeaderCell className="w-[60px]">{tc.headers.when}</HeaderCell>
      </TableHeader>
      {rows.map((f) => (
        <div key={f.name} className={ROW_CLASS}>
          <div className="flex-1 min-w-0 flex items-center gap-2">
            <FileText className={cn('h-4 w-4 shrink-0', FILE_ICON_TONE[f.ext] ?? FILE_ICON_TONE.default)} />
            <span className="text-sm text-foreground truncate">
              {f.name}.<span className="text-muted-foreground">{f.ext}</span>
            </span>
          </div>
          <div className="w-[60px] text-xs text-muted-foreground tabular-nums">{f.size}</div>
          <div className="w-[80px] text-xs text-muted-foreground truncate">{f.author}</div>
          <div className="w-[60px] text-xs text-muted-foreground">{f.when}</div>
        </div>
      ))}
    </CardShell>
  );
}

// ---------- WeldCall — matches /weldcall/history row (call-intelligence-client.tsx) ----------
export type CallStatus = 'completed' | 'failed' | 'busy' | 'no_answer' | 'canceled' | 'answered' | 'ringing';

const CALL_STATUS: Record<CallStatus, { color: string; bg: string }> = {
  completed: { color: 'text-gray-600 dark:text-muted-foreground', bg: 'bg-gray-100 dark:bg-secondary' },
  failed: { color: 'text-red-600 dark:text-red-400', bg: 'bg-red-50 dark:bg-red-950' },
  busy: { color: 'text-orange-600 dark:text-orange-400', bg: 'bg-orange-50 dark:bg-orange-950' },
  no_answer: { color: 'text-gray-600 dark:text-muted-foreground', bg: 'bg-gray-100 dark:bg-secondary' },
  canceled: { color: 'text-gray-600 dark:text-muted-foreground', bg: 'bg-gray-100 dark:bg-secondary' },
  answered: { color: 'text-emerald-600 dark:text-emerald-400', bg: 'bg-emerald-50 dark:bg-emerald-950' },
  ringing: { color: 'text-yellow-600 dark:text-yellow-400', bg: 'bg-yellow-50 dark:bg-yellow-950' },
};

export type CallRow = {
  direction: 'inbound' | 'outbound';
  from: string;
  to: string;
  duration: string;
  isRecorded: boolean;
  status: CallStatus;
  date: string;
};

const DEMO_CALLS: CallRow[] = [
  { direction: 'inbound', from: '+32 471 22 18 03', to: '+32 2 808 12 34', duration: '12:04', isRecorded: true, status: 'completed', date: '2026-05-20 09:15' },
  { direction: 'outbound', from: '+32 2 808 12 34', to: '+31 20 555 4080', duration: '03:42', isRecorded: false, status: 'completed', date: '2026-05-20 08:48' },
  { direction: 'inbound', from: '+32 9 244 11 80', to: '+32 2 808 12 34', duration: '07:21', isRecorded: true, status: 'completed', date: '2026-05-19 14:30' },
  { direction: 'outbound', from: '+32 2 808 12 34', to: '+44 20 7946 0991', duration: '00:00', isRecorded: false, status: 'no_answer', date: '2026-05-19 11:12' },
  { direction: 'inbound', from: '+32 471 22 18 03', to: '+32 2 808 12 34', duration: '00:42', isRecorded: false, status: 'busy', date: '2026-05-19 10:05' },
  { direction: 'outbound', from: '+32 2 808 12 34', to: '+49 30 88 71 90', duration: '18:36', isRecorded: true, status: 'completed', date: '2026-05-18 16:20' },
  { direction: 'inbound', from: '+33 1 76 36 41 80', to: '+32 2 808 12 34', duration: '04:55', isRecorded: false, status: 'failed', date: '2026-05-18 09:48' },
];

export function CallCard({
  rows = DEMO_CALLS,
  isLoading = false,
  isDemo = false,
}: Readonly<{ rows?: CallRow[]; isLoading?: boolean; isDemo?: boolean }> = {}) {
  const { t } = useI18n();
  const tc = t.weldsuiteHome.cards;
  if (isLoading) {
    return <CardShell><div className="p-3"><SkeletonRows count={5} variant="table" /></div></CardShell>;
  }
  if (rows.length === 0) {
    return <CardShell><EmptyState kind="calls" /></CardShell>;
  }
  return (
    <CardShell action={isDemo ? <DemoBadge /> : null}>
      <FitContent>
      <TableHeader>
        <HeaderCell className="w-[80px]">{tc.headers.direction}</HeaderCell>
        <HeaderCell className="w-[100px]">{tc.headers.from}</HeaderCell>
        <HeaderCell className="flex-1">{tc.headers.to}</HeaderCell>
        <HeaderCell className="w-[50px]">{tc.headers.duration}</HeaderCell>
        <HeaderCell className="w-[70px]">{tc.headers.recording}</HeaderCell>
        <HeaderCell className="w-[80px]">{tc.headers.status}</HeaderCell>
        <HeaderCell className="w-[100px]">{tc.headers.date}</HeaderCell>
      </TableHeader>
      {rows.map((c) => {
        const status = CALL_STATUS[c.status];
        return (
          <div key={c.from + c.date} className={ROW_CLASS}>
            {/* Direction */}
            <div className="w-[80px] flex items-center gap-2">
              {c.direction === 'inbound' ? (
                <PhoneIncoming className="h-4 w-4 text-green-600 shrink-0" />
              ) : (
                <PhoneOutgoing className="h-4 w-4 text-blue-600 shrink-0" />
              )}
              <span className="text-sm truncate">{tc.callDirection[c.direction]}</span>
            </div>

            {/* From — mono phone */}
            <div className="w-[100px] min-w-0">
              <span className="font-mono text-sm text-gray-700 dark:text-muted-foreground truncate block">
                {c.from}
              </span>
            </div>

            {/* To — mono phone, flex-1 */}
            <div className="flex-1 min-w-0">
              <span className="font-mono text-sm text-gray-700 dark:text-muted-foreground truncate block">
                {c.to}
              </span>
            </div>

            {/* Duration — mono muted */}
            <div className="w-[50px] text-sm font-mono text-gray-500 dark:text-muted-foreground tabular-nums">
              {c.duration}
            </div>

            {/* Recording — Recorded red pill or No gray pill */}
            <div className="w-[70px]">
              {c.isRecorded ? (
                <span className="inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950">
                  {tc.callRecorded}
                </span>
              ) : (
                <span className="inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none text-gray-600 dark:text-muted-foreground bg-gray-100 dark:bg-secondary">
                  {tc.callNotRecorded}
                </span>
              )}
            </div>

            {/* Status pill — same h-[22px] style with config color/bg */}
            <div className="w-[80px]">
              <span className={cn(
                'inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none',
                status.color,
                status.bg
              )}>
                {tc.callStatus[c.status]}
              </span>
            </div>

            {/* Date — mono small */}
            <div className="w-[100px]">
              <span className="text-sm font-mono text-gray-500 dark:text-muted-foreground truncate block">
                {c.date}
              </span>
            </div>
          </div>
        );
      })}
      </FitContent>
    </CardShell>
  );
}

// ---------- WeldCalendar — shared event data ----------
type CalEvent = {
  day: number; // 0 = today (Wed 20), 1 = Thu 21, etc.
  time: string;
  endTime: string;
  duration: string;
  title: string;
  attendees: number;
  color: string;
};

type CalCards = ReturnType<typeof useI18n>['t']['weldsuiteHome']['cards'];

function buildCalEvents(tc: CalCards): CalEvent[] {
  const ti = tc.calendar.titles;
  const du = tc.calendar.durations;
  return [
    // Today (Wed May 20)
    { day: 0, time: '09:00', endTime: '09:15', duration: du.min15, title: ti.engineeringStandup, attendees: 8, color: 'bg-blue-500' },
    { day: 0, time: '10:00', endTime: '11:00', duration: du.hour1, title: ti.weeklyLeadershipSync, attendees: 6, color: 'bg-violet-500' },
    { day: 0, time: '11:30', endTime: '12:00', duration: du.min30, title: ti.demoAcme, attendees: 3, color: 'bg-emerald-500' },
    { day: 0, time: '14:00', endTime: '14:30', duration: du.min30, title: ti.oneOnOneLien, attendees: 2, color: 'bg-amber-500' },
    { day: 0, time: '16:00', endTime: '17:30', duration: du.hour1min30, title: ti.roadmapPlanningQ3, attendees: 8, color: 'bg-pink-500' },
    // Thu 21
    { day: 1, time: '09:30', endTime: '10:00', duration: du.min30, title: ti.coffeeWithSara, attendees: 2, color: 'bg-cyan-500' },
    { day: 1, time: '11:00', endTime: '12:00', duration: du.hour1, title: ti.productReview, attendees: 5, color: 'bg-blue-500' },
    { day: 1, time: '15:00', endTime: '16:00', duration: du.hour1, title: ti.salesCallBlueTrack, attendees: 4, color: 'bg-orange-500' },
    // Fri 22
    { day: 2, time: '10:00', endTime: '11:30', duration: du.hour1min30, title: ti.designReview, attendees: 4, color: 'bg-violet-500' },
    { day: 2, time: '14:00', endTime: '15:30', duration: du.hour1min30, title: ti.customerInterviewVinta, attendees: 3, color: 'bg-emerald-500' },
    // Sat 23
    { day: 3, time: '09:00', endTime: '17:00', duration: du.allDay, title: ti.offsiteStrategyDay, attendees: 12, color: 'bg-rose-500' },
  ];
}

function buildCalDayLabels(tc: CalCards) {
  const wd = tc.calendar.weekdays;
  const days = tc.calendar.days;
  return [
    { full: days.today, short: wd.wed, date: '20', today: true },
    { full: days.tomorrow, short: wd.thu, date: '21', today: false },
    { full: days.friday, short: wd.fri, date: '22', today: false },
    { full: days.saturday, short: wd.sat, date: '23', today: false },
  ];
}

// ---------- WeldCalendar (week strip + agenda) ----------
function buildWeek(tc: CalCards) {
  const wd = tc.calendar.weekdays;
  return [
    { day: wd.mon, date: '18', events: 4, today: false },
    { day: wd.tue, date: '19', events: 2, today: false },
    { day: wd.wed, date: '20', events: 6, today: true },
    { day: wd.thu, date: '21', events: 3, today: false },
    { day: wd.fri, date: '22', events: 1, today: false },
    { day: wd.sat, date: '23', events: 0, today: false },
    { day: wd.sun, date: '24', events: 0, today: false },
  ];
}

function buildAgenda(tc: CalCards) {
  const ti = tc.calendar.titles;
  return [
    { time: '10:00', title: ti.weeklyLeadershipSync, tone: 'bg-blue-500' },
    { time: '11:30', title: ti.demoAcme, tone: 'bg-emerald-500' },
    { time: '14:00', title: ti.oneOnOneLien, tone: 'bg-amber-500' },
    { time: '16:00', title: ti.roadmapPlanningQ3, tone: 'bg-violet-500' },
  ];
}

export function CalendarCard({ isDemo = false }: Readonly<{ isDemo?: boolean }> = {}) {
  const { t } = useI18n();
  const tc = t.weldsuiteHome.cards;
  const week = buildWeek(tc);
  const agenda = buildAgenda(tc);
  return (
    <CardShell action={isDemo ? <DemoBadge /> : null}>
      <div className="border-b border-border/70 bg-background sticky top-0 z-10">
        <div className="grid grid-cols-7 divide-x divide-border/70">
          {week.map((d) => (
            <Link
              key={d.day}
              to="/weldcalendar"
              className={cn(
                'flex flex-col items-center gap-0.5 py-2.5 transition-colors cursor-pointer',
                d.today ? 'bg-muted hover:bg-muted' : 'hover:bg-muted/50'
              )}
            >
              <div className="text-[10px] text-muted-foreground uppercase tracking-wide">{d.day}</div>
              <div className={cn('text-base font-semibold tabular-nums', d.today ? 'text-primary' : 'text-foreground')}>
                {d.date}
              </div>
            </Link>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-4 px-4 h-[35px] border-b border-border/70 bg-muted/30">
        <HeaderCell className="w-[60px] shrink-0">{tc.headers.time}</HeaderCell>
        <HeaderCell className="flex-1">{tc.headers.event}</HeaderCell>
      </div>
      {agenda.map((a) => (
        <div key={a.time + a.title} className={ROW_CLASS}>
          <div className="w-[60px] text-xs text-muted-foreground tabular-nums shrink-0">{a.time}</div>
          <span className={cn('h-2 w-2 rounded-full shrink-0', a.tone)} />
          <div className="flex-1 text-sm text-foreground truncate">{a.title}</div>
        </div>
      ))}
    </CardShell>
  );
}

// ---------- WeldCalendar Schedule view ----------
export function CalendarScheduleCard({ isDemo = false }: Readonly<{ isDemo?: boolean }> = {}) {
  const { t } = useI18n();
  const tc = t.weldsuiteHome.cards;
  const calEvents = buildCalEvents(tc);
  const dayLabels = buildCalDayLabels(tc);
  const groups = dayLabels.map((day, i) => ({
    label: day.full,
    today: day.today,
    events: calEvents.filter((e) => e.day === i),
  })).filter((g) => g.events.length > 0);

  return (
    <CardShell action={isDemo ? <DemoBadge /> : null}>
      {groups.map((group) => (
        <div key={group.label}>
          {/* Day header */}
          <div className="px-4 h-[28px] flex items-center border-b border-border/40 bg-muted/30 sticky top-0 z-10">
            <span className={cn(
              'text-[11px] font-semibold uppercase tracking-wide',
              group.today ? 'text-primary' : 'text-muted-foreground'
            )}>
              {group.label}
            </span>
          </div>
          {/* Events */}
          {group.events.map((event) => (
            <div
              key={`${event.time}-${event.title}`}
              className="flex items-center gap-3 px-4 h-[44px] hover:bg-gray-50 dark:hover:bg-secondary/50 cursor-pointer border-b border-gray-200/70 dark:border-border last:border-b-0"
            >
              <div className="w-[50px] shrink-0">
                <span className="text-xs font-mono text-foreground tabular-nums">{event.time}</span>
              </div>
              <div className={cn('w-1 h-6 rounded-full shrink-0', event.color)} />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-foreground truncate">{event.title}</div>
              </div>
              <span className="text-[11px] font-mono text-muted-foreground tabular-nums shrink-0">
                {event.duration}
              </span>
            </div>
          ))}
        </div>
      ))}
    </CardShell>
  );
}

// ---------- WeldCalendar 4-Day view ----------
export function CalendarFourDayCard({ isDemo = false }: Readonly<{ isDemo?: boolean }> = {}) {
  const { t, plural } = useI18n();
  const tc = t.weldsuiteHome.cards;
  const calEvents = buildCalEvents(tc);
  const dayLabels = buildCalDayLabels(tc);
  return (
    <CardShell action={isDemo ? <DemoBadge /> : null}>
      <div className="flex divide-x divide-border/60 h-full">
        {dayLabels.map((day, i) => {
          const events = calEvents.filter((e) => e.day === i);
          return (
            <div key={day.date} className="flex-1 min-w-0 flex flex-col min-h-0">
              {/* Day header */}
              <div className={cn(
                'flex flex-col items-center justify-center py-2 border-b border-border/60 shrink-0',
                day.today && 'bg-primary/5'
              )}>
                <div className={cn(
                  'text-[10px] uppercase tracking-wide',
                  day.today ? 'text-primary' : 'text-muted-foreground'
                )}>
                  {day.short}
                </div>
                <div className={cn(
                  'text-lg font-semibold leading-none mt-0.5',
                  day.today ? 'text-primary' : 'text-foreground'
                )}>
                  {day.date}
                </div>
                <div className="text-[10px] text-muted-foreground mt-1">{plural(events.length, tc.calendar.eventsShort)}</div>
              </div>
              {/* Event blocks */}
              <div className="flex flex-col gap-1 p-1.5 flex-1">
                {events.map((event) => (
                  <div
                    key={`${event.time}-${event.title}`}
                    className={cn('rounded px-1.5 py-1 text-white text-[10px] cursor-pointer', event.color)}
                  >
                    <div className="font-mono opacity-80">{event.time}</div>
                    <div className="font-medium leading-tight line-clamp-2 mt-0.5">{event.title}</div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </CardShell>
  );
}

// ---------- WeldCalendar Day view ----------
export function CalendarDayCard({ isDemo = false }: Readonly<{ isDemo?: boolean }> = {}) {
  const { t, plural } = useI18n();
  const tc = t.weldsuiteHome.cards;
  const calEvents = buildCalEvents(tc);
  const dayLabels = buildCalDayLabels(tc);
  const todayEvents = calEvents.filter((e) => e.day === 0);
  return (
    <CardShell action={isDemo ? <DemoBadge /> : null}>
      {/* Day header */}
      <div className="flex items-center justify-between px-4 h-[35px] border-b border-border/70 bg-muted/30 sticky top-0 z-10">
        <span className="text-xs font-semibold text-foreground">{dayLabels[0].full}</span>
        <span className="text-xs text-muted-foreground tabular-nums">{plural(todayEvents.length, tc.calendar.events)}</span>
      </div>
      {todayEvents.map((event) => (
        <div
          key={`${event.time}-${event.title}`}
          className="flex items-center gap-3 px-4 h-[75px] hover:bg-gray-50 dark:hover:bg-secondary/50 cursor-pointer border-b border-gray-200/70 dark:border-border last:border-b-0"
        >
          {/* Time range */}
          <div className="w-[55px] shrink-0">
            <div className="text-sm font-mono text-foreground tabular-nums">{event.time}</div>
            <div className="text-[11px] font-mono text-muted-foreground tabular-nums">– {event.endTime}</div>
          </div>
          {/* Colored bar */}
          <div className={cn('w-1 h-12 rounded-full shrink-0', event.color)} />
          {/* Title + meta */}
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-foreground truncate">{event.title}</div>
            <div className="text-xs text-muted-foreground">
              {event.duration} · {plural(event.attendees, tc.calendar.attendees)}
            </div>
          </div>
        </div>
      ))}
    </CardShell>
  );
}