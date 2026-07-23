/**
 * `CallHistoryList` — the single source of truth for the call-history list UI.
 *
 * This is the EntityList (header columns, direction/status/recording filters,
 * date grouping, the per-call row, and the empty state) shared by BOTH:
 *   - the full-page WeldCall history view (`call-intelligence-client.tsx`)
 *   - the Calls tab inside the CRM object panels (`calls-tab.tsx`)
 *
 * Keeping the list here means the two surfaces never drift: change a column,
 * a badge tone, or the row layout once and both update. Page-level chrome
 * (breadcrumbs, stats, the `min-h-screen` shell) stays in the page wrapper;
 * the tab supplies its own container. Everything visual about a call row is
 * defined here.
 */

import { useCallback, useMemo } from 'react';
import { useRouter, Link } from '@/lib/router';
import { getTranslations } from '@/lib/i18n';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import {
  PhoneIncoming,
  PhoneOutgoing,
  EllipsisVertical,
  FileText,
  Link2,
  Trash2,
  Play,
} from 'lucide-react';
import { format } from 'date-fns';
import { useCall } from '@/contexts/call-context';
import {
  EntityList,
  EmptyStateIllustration,
  type HeaderColumn,
  type FilterConfig,
  type GroupConfig,
  type ActiveFilter,
  type RowHandlers,
} from '@/components/entity-list';
import { cn } from '@/lib/utils';
import type { VoipCall } from '@/lib/api/domains/call-intelligence';

export function formatCallDuration(seconds?: number) {
  if (!seconds) return '--';
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) {
    return `${hours}h ${mins}m ${secs}s`;
  }
  return `${mins}m ${secs}s`;
}

export function formatPhoneNumber(number: string): string {
  if (!number) return '';
  const cleaned = number.replace(/[^\d+]/g, '');

  if (cleaned.startsWith('+1') && cleaned.length === 12) {
    return `+1 (${cleaned.slice(2, 5)}) ${cleaned.slice(5, 8)}-${cleaned.slice(8)}`;
  }
  if (cleaned.startsWith('+44') && cleaned.length >= 12) {
    const national = cleaned.slice(3);
    if (national.startsWith('7')) {
      return `+44 ${national.slice(0, 4)} ${national.slice(4, 7)} ${national.slice(7)}`;
    }
    return `+44 ${national.slice(0, 2)} ${national.slice(2, 6)} ${national.slice(6)}`;
  }
  if (cleaned.startsWith('+31') && cleaned.length >= 11) {
    const national = cleaned.slice(3);
    if (national.startsWith('6')) {
      return `+31 6 ${national.slice(1, 5)} ${national.slice(5)}`;
    }
    return `+31 ${national.slice(0, 2)} ${national.slice(2, 5)} ${national.slice(5)}`;
  }
  if (cleaned.startsWith('+49') && cleaned.length >= 12) {
    const national = cleaned.slice(3);
    if (national.startsWith('1')) {
      return `+49 ${national.slice(0, 3)} ${national.slice(3, 7)} ${national.slice(7)}`;
    }
    return `+49 ${national.slice(0, 2)} ${national.slice(2, 6)} ${national.slice(6)}`;
  }
  if (cleaned.startsWith('+33') && cleaned.length === 12) {
    const national = cleaned.slice(3);
    return `+33 ${national.slice(0, 1)} ${national.slice(1, 3)} ${national.slice(3, 5)} ${national.slice(5, 7)} ${national.slice(7)}`;
  }
  if (cleaned.startsWith('+32') && cleaned.length >= 11) {
    const national = cleaned.slice(3);
    return `+32 ${national.slice(0, 3)} ${national.slice(3, 5)} ${national.slice(5, 7)} ${national.slice(7)}`;
  }
  if (cleaned.startsWith('+') && cleaned.length > 7) {
    const countryCode = cleaned.slice(0, cleaned.length > 12 ? 3 : (cleaned.length > 11 ? 2 : 2));
    const rest = cleaned.slice(countryCode.length);
    const groups = rest.match(/.{1,4}/g) || [];
    return `${countryCode} ${groups.join(' ')}`;
  }
  return number;
}

// Status configuration — color/bg tokens only; labels are resolved via i18n inside the component
export const callStatusConfig: Record<string, { label: string; color: string; bg: string }> = {
  'initiated': { label: 'Initiated', color: 'text-blue-600 dark:text-blue-400', bg: 'bg-blue-50 dark:bg-blue-950' },
  'ringing': { label: 'Ringing', color: 'text-yellow-600 dark:text-yellow-400', bg: 'bg-yellow-50 dark:bg-yellow-950' },
  'answered': { label: 'Connected', color: 'text-emerald-600 dark:text-emerald-400', bg: 'bg-emerald-50 dark:bg-emerald-950' },
  'bridged': { label: 'Connected', color: 'text-emerald-600 dark:text-emerald-400', bg: 'bg-emerald-50 dark:bg-emerald-950' },
  'recording': { label: 'Recording', color: 'text-red-600 dark:text-red-400', bg: 'bg-red-50 dark:bg-red-950' },
  'completed': { label: 'Completed', color: 'text-gray-600 dark:text-muted-foreground', bg: 'bg-gray-100 dark:bg-secondary' },
  'failed': { label: 'Failed', color: 'text-red-600 dark:text-red-400', bg: 'bg-red-50 dark:bg-red-950' },
  'busy': { label: 'Busy', color: 'text-orange-600 dark:text-orange-400', bg: 'bg-orange-50 dark:bg-orange-950' },
  'no_answer': { label: 'No Answer', color: 'text-gray-600 dark:text-muted-foreground', bg: 'bg-gray-100 dark:bg-secondary' },
  'canceled': { label: 'Canceled', color: 'text-gray-600 dark:text-muted-foreground', bg: 'bg-gray-100 dark:bg-secondary' },
};

// Map API status keys to i18n keys in weldmeet.weldcall.callHistory.status
const statusToI18nKey: Record<string, string> = {
  initiated: 'initiated',
  ringing: 'ringing',
  answered: 'answered',
  bridged: 'bridged',
  recording: 'recording',
  completed: 'completed',
  failed: 'failed',
  busy: 'busy',
  no_answer: 'noAnswer',
  canceled: 'canceled',
};

export interface CallHistoryListProps {
  calls: VoipCall[];
  voipConfigured: boolean;
  /** Loading state forwarded to the EntityList skeleton. */
  isLoading?: boolean;
  /**
   * Page-level surfaces show a "Phone Settings" link in the toolbar. The
   * compact panel tab hides it. Defaults to shown.
   */
  showPhoneSettings?: boolean;
}

export function CallHistoryList({
  calls,
  voipConfigured,
  isLoading = false,
  showPhoneSettings = true,
}: CallHistoryListProps) {
  const router = useRouter();
  const { setIsDialerOpen } = useCall();
  const t = getTranslations('weldmeet');
  const tc = t.weldcall.callHistory;

  const handleCallClick = useCallback((call: VoipCall) => {
    router.push(`/weldcall/${call.id}`);
  }, [router]);

  // Filter configurations
  const filterConfigs: FilterConfig[] = useMemo(() => [
    {
      field: 'direction',
      label: tc.filters.direction,
      options: [
        { value: 'inbound', label: tc.filters.inbound },
        { value: 'outbound', label: tc.filters.outbound },
      ],
    },
    {
      field: 'status',
      label: tc.filters.status,
      options: Object.entries(callStatusConfig).map(([key]) => {
        const i18nKey = statusToI18nKey[key] as keyof typeof tc.status | undefined;
        const label = i18nKey ? tc.status[i18nKey] : callStatusConfig[key].label;
        return { value: key, label };
      }),
      getDisplayValue: (value) => {
        const i18nKey = statusToI18nKey[value] as keyof typeof tc.status | undefined;
        return i18nKey ? tc.status[i18nKey] : (callStatusConfig[value]?.label || value);
      },
    },
    {
      field: 'recording',
      label: tc.filters.recording,
      options: [
        { value: 'yes', label: tc.filters.recorded },
        { value: 'no', label: tc.filters.notRecorded },
      ],
    },
  ], [tc]);

  // Group configurations - by date
  const groupConfigs: GroupConfig<VoipCall>[] = useMemo(() => {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfYesterday = new Date(startOfToday.getTime() - 24 * 60 * 60 * 1000);
    const startOfWeek = new Date(startOfToday.getTime() - 7 * 24 * 60 * 60 * 1000);

    return [
      {
        id: 'today',
        label: tc.groups.today,
        sortOrder: 1,
        filter: (call) => {
          const date = call.initiatedAt ? new Date(call.initiatedAt) : null;
          return date ? date >= startOfToday : false;
        },
      },
      {
        id: 'yesterday',
        label: tc.groups.yesterday,
        sortOrder: 2,
        filter: (call) => {
          const date = call.initiatedAt ? new Date(call.initiatedAt) : null;
          return date ? date >= startOfYesterday && date < startOfToday : false;
        },
      },
      {
        id: 'this-week',
        label: tc.groups.thisWeek,
        sortOrder: 3,
        filter: (call) => {
          const date = call.initiatedAt ? new Date(call.initiatedAt) : null;
          return date ? date >= startOfWeek && date < startOfYesterday : false;
        },
      },
      {
        id: 'older',
        label: tc.groups.older,
        sortOrder: 4,
        filter: (call) => {
          const date = call.initiatedAt ? new Date(call.initiatedAt) : null;
          return date ? date < startOfWeek : !call.initiatedAt;
        },
      },
    ];
  }, [tc]);

  // Apply filters function
  const applyFilters = useCallback((items: VoipCall[], filters: ActiveFilter[]) => {
    let result = items;

    filters.forEach(filter => {
      if (!filter.operator || !filter.value) return;

      if (filter.field === 'direction') {
        result = filter.operator === 'is'
          ? result.filter(c => c.direction?.toLowerCase() === filter.value)
          : result.filter(c => c.direction?.toLowerCase() !== filter.value);
      } else if (filter.field === 'status') {
        result = filter.operator === 'is'
          ? result.filter(c => c.status?.toLowerCase() === filter.value)
          : result.filter(c => c.status?.toLowerCase() !== filter.value);
      } else if (filter.field === 'recording') {
        const hasRecording = filter.value === 'yes';
        result = filter.operator === 'is'
          ? result.filter(c => c.isRecorded === hasRecording)
          : result.filter(c => c.isRecorded !== hasRecording);
      }
    });

    return result;
  }, []);

  // Header columns
  const headerColumns: HeaderColumn[] = useMemo(() => [
    { id: 'direction', header: tc.columns.direction, width: 'w-[120px]' },
    { id: 'from', header: tc.columns.from, width: 'w-[180px]' },
    { id: 'to', header: tc.columns.to, width: 'flex-1' },
    { id: 'duration', header: tc.columns.duration, width: 'w-[120px]' },
    { id: 'recording', header: tc.columns.recording, width: 'w-[100px]' },
    { id: 'status', header: tc.columns.status, width: 'w-[120px]' },
    { id: 'date', header: tc.columns.date, width: 'w-[170px]' },
  ], [tc]);

  // Row renderer
  const renderCallRow = useCallback((call: VoipCall, _handlers: RowHandlers<VoipCall>) => (
    <div
      key={call.id}
      onClick={() => handleCallClick(call)}
      className="flex items-center gap-4 px-4 py-3 border-b border-gray-200/70 dark:border-border group cursor-pointer hover:bg-gray-50 dark:hover:bg-background/50"
    >
      {/* Direction */}
      <div className="w-[120px] flex items-center gap-2">
        {call.direction?.toLowerCase() === 'inbound' ? (
          <PhoneIncoming className="h-4 w-4 text-green-600" />
        ) : (
          <PhoneOutgoing className="h-4 w-4 text-blue-600" />
        )}
        <span className="text-sm capitalize">{call.direction || 'Unknown'}</span>
      </div>

      {/* From */}
      <div className="w-[180px]">
        <span className="font-mono text-sm text-gray-700 dark:text-muted-foreground">
          {call.fromNumberFormatted || formatPhoneNumber(call.fromNumber || '')}
        </span>
      </div>

      {/* To */}
      <div className="flex-1">
        <span className="font-mono text-sm text-gray-700 dark:text-muted-foreground">
          {call.toNumberFormatted || formatPhoneNumber(call.toNumber || '')}
        </span>
      </div>

      {/* Duration */}
      <div className="w-[120px] text-sm font-mono text-gray-500 dark:text-muted-foreground">
        <span>{formatCallDuration(call.duration)}</span>
      </div>

      {/* Recording */}
      <div className="w-[100px]">
        {call.isRecorded ? (
          <span className="-translate-y-[1.5px] inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950">
            {tc.recordingBadge}
          </span>
        ) : (
          <span className="-translate-y-[1.5px] inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none text-gray-600 dark:text-muted-foreground bg-gray-100 dark:bg-secondary">
            {tc.noRecordingBadge}
          </span>
        )}
      </div>

      {/* Status */}
      <div className="w-[120px]">
        {(() => {
          const statusKey = call.status?.toLowerCase() || '';
          const status = callStatusConfig[statusKey];
          const i18nKey = statusToI18nKey[statusKey] as keyof typeof tc.status | undefined;
          const statusLabel = i18nKey ? tc.status[i18nKey] : (status?.label || call.status || tc.status.unknown);
          return (
            <span className={cn(
              "-translate-y-[1.5px] inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none",
              status?.color || 'text-gray-600 dark:text-muted-foreground',
              status?.bg || 'bg-gray-100 dark:bg-secondary'
            )}>
              {statusLabel}
            </span>
          );
        })()}
      </div>

      {/* Date */}
      <div className="w-[170px]">
        {call.initiatedAt ? (
          <span className="text-sm font-mono text-gray-500 dark:text-muted-foreground">
            {format(new Date(call.initiatedAt), 'yyyy-MM-dd HH:mm')}
          </span>
        ) : (
          <span className="text-gray-400">—</span>
        )}
      </div>

      {/* Actions */}
      <div className="w-[40px] flex justify-end" onClick={(e) => e.stopPropagation()}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100 data-[state=open]:bg-accent">
              <EllipsisVertical className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => handleCallClick(call)}>
              <FileText className="mr-0.5 h-4 w-4" />
              {tc.actions.viewDetails}
            </DropdownMenuItem>
            {call.isRecorded && (
              <DropdownMenuItem>
                <Play className="mr-0.5 h-4 w-4" />
                {tc.actions.playRecording}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem>
              <Link2 className="mr-0.5 h-4 w-4" />
              {tc.actions.linkToCrm}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-red-600 hover:!bg-red-50 hover:!text-red-600 dark:text-red-400 dark:hover:!bg-red-950 dark:hover:!text-red-400">
              <Trash2 className="mr-0.5 h-4 w-4 text-red-600 dark:text-red-400" />
              {tc.actions.delete}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  ), [handleCallClick]);

  return (
    <EntityList<VoipCall>
      items={calls}
      isLoading={isLoading}
      error={null}
      headerColumns={headerColumns}
      filters={filterConfigs}
      groups={groupConfigs}
      maxFilters={5}
      applyFilters={applyFilters}
      renderRow={renderCallRow}
      searchPlaceholder={tc.searchPlaceholder}
      searchFields={['fromNumber', 'toNumber', 'fromNumberFormatted', 'toNumberFormatted']}
      actionButtons={
        showPhoneSettings ? (
          <Button variant="outline" size="sm" className="h-8 shadow-none text-muted-foreground" asChild>
            <Link href="/settings/apps/phone-numbers">
              {tc.phoneSettings}
            </Link>
          </Button>
        ) : undefined
      }
      createButton={{
        label: tc.makeCall,
        onClick: () => setIsDialerOpen(true),
      }}
      emptyState={{
        icon: (
          <EmptyStateIllustration>
            <svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
              {/* Speech bubble body */}
              <path d="M30 18H90C94.4 18 98 21.6 98 26V66C98 70.4 94.4 74 90 74H56L42 88L42 74H30C25.6 74 22 70.4 22 66V26C22 21.6 25.6 18 30 18Z" className="fill-white dark:fill-white/[0.03]" />
              <path d="M30 18H90C94.4 18 98 21.6 98 26V66C98 70.4 94.4 74 90 74H56L42 88L42 74H30C25.6 74 22 70.4 22 66V26C22 21.6 25.6 18 30 18Z" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="1" fill="none" />
              {/* Waveform bars */}
              <rect x="33" y="44" width="2.5" height="6" rx="1.25" className="fill-gray-200 dark:fill-white/20" opacity="0.4" />
              <rect x="38" y="41" width="2.5" height="12" rx="1.25" className="fill-gray-300 dark:fill-white/20" opacity="0.5" />
              <rect x="43" y="37" width="2.5" height="20" rx="1.25" className="fill-gray-300 dark:fill-white/20" opacity="0.65" />
              <rect x="48" y="40" width="2.5" height="14" rx="1.25" className="fill-gray-300 dark:fill-white/20" opacity="0.6" />
              <rect x="53" y="34" width="2.5" height="26" rx="1.25" className="fill-gray-300 dark:fill-white/20" opacity="0.7" />
              <rect x="58" y="39" width="2.5" height="16" rx="1.25" className="fill-gray-300 dark:fill-white/20" opacity="0.65" />
              <rect x="63" y="36" width="2.5" height="22" rx="1.25" className="fill-gray-300 dark:fill-white/20" opacity="0.7" />
              <rect x="68" y="40" width="2.5" height="14" rx="1.25" className="fill-gray-300 dark:fill-white/20" opacity="0.6" />
              <rect x="73" y="38" width="2.5" height="18" rx="1.25" className="fill-gray-200 dark:fill-white/20" opacity="0.5" />
              <rect x="78" y="42" width="2.5" height="10" rx="1.25" className="fill-gray-200 dark:fill-white/20" opacity="0.4" />
              <rect x="83" y="44" width="2.5" height="6" rx="1.25" className="fill-gray-200 dark:fill-white/20" opacity="0.3" />
              <rect x="88" y="45" width="2.5" height="4" rx="1.25" className="fill-gray-200 dark:fill-white/20" opacity="0.2" />
            </svg>
          </EmptyStateIllustration>
        ),
        title: tc.emptyState.title,
        description: voipConfigured
          ? tc.emptyState.descriptionConfigured
          : tc.emptyState.descriptionNotConfigured,
        action: voipConfigured ? {
          label: tc.makeCall,
          onClick: () => setIsDialerOpen(true),
        } : undefined,
      }}
      noResultsState={{
        title: tc.noResults.title,
        description: tc.noResults.description,
      }}
    />
  );
}
