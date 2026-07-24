
import { useCallback, useMemo } from 'react';
import { Badge } from '@weldsuite/ui/components/badge';
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
  PhoneMissed,
  Clock,
  EllipsisVertical,
  FileText,
  Link2,
  Trash2,
  Play,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { useCall } from '@/contexts/call-context';
import { EntityList, EmptyStateIllustration, type HeaderColumn, type FilterConfig, type GroupConfig, type ActiveFilter } from '@/components/entity-list';
import { cn } from '@/lib/utils';
import { useCustomerDetailContext } from '../customer-detail-provider';
import type { CallsSectionProps, Activity } from '../types';
import { useTranslations } from '@weldsuite/i18n/client';

function formatDuration(seconds?: number) {
  if (!seconds) return '--:--';
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m ${secs}s`;
}

// Extend Activity with computed fields for EntityList
interface CallItem extends Activity {
  computedDirection: string;
  computedStatus: string;
}

export function CallsSection({ customer, activities }: CallsSectionProps) {
  const t = useTranslations();
  const { onCall } = useCustomerDetailContext();
  const { setIsDialerOpen } = useCall();

  const statusConfig: Record<string, { label: string; color: string }> = useMemo(() => ({
    'completed': { label: t('sweep.weldcrm.callsSection.statusCompleted'), color: 'bg-muted text-muted-foreground' },
    'answered': { label: t('sweep.weldcrm.callsSection.statusAnswered'), color: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400' },
    'missed': { label: t('sweep.weldcrm.callsSection.statusMissed'), color: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400' },
    'no_answer': { label: t('sweep.weldcrm.callsSection.statusNoAnswer'), color: 'bg-muted text-muted-foreground' },
    'busy': { label: t('sweep.weldcrm.callsSection.statusBusy'), color: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400' },
    'failed': { label: t('sweep.weldcrm.callsSection.statusFailed'), color: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400' },
    'canceled': { label: t('sweep.weldcrm.callsSection.statusCanceled'), color: 'bg-muted text-muted-foreground' },
  }), [t]);

  const calls: CallItem[] = useMemo(() =>
    activities
      .filter(a => a.type === 'call')
      .map(a => ({
        ...a,
        computedDirection: a.callDirection || 'outbound',
        computedStatus: a.status || 'completed',
      })),
    [activities]
  );

  // Filter configurations
  const filterConfigs: FilterConfig[] = useMemo(() => [
    {
      field: 'direction',
      label: t('sweep.weldcrm.callsSection.direction'),
      options: [
        { value: 'inbound', label: t('sweep.weldcrm.callsSection.inbound') },
        { value: 'outbound', label: t('sweep.weldcrm.callsSection.outbound') },
        { value: 'missed', label: t('sweep.weldcrm.callsSection.missed') },
      ],
    },
    {
      field: 'status',
      label: t('sweep.weldcrm.callsSection.status'),
      options: Object.entries(statusConfig).map(([key, config]) => ({
        value: key,
        label: config.label,
      })),
      getDisplayValue: (value) => statusConfig[value]?.label || value,
    },
  ], [t, statusConfig]);

  // Group configurations - by date
  const groupConfigs: GroupConfig<CallItem>[] = useMemo(() => {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfYesterday = new Date(startOfToday.getTime() - 24 * 60 * 60 * 1000);
    const startOfWeek = new Date(startOfToday.getTime() - 7 * 24 * 60 * 60 * 1000);

    return [
      {
        id: 'today',
        label: t('sweep.weldcrm.notesView.today'),
        sortOrder: 1,
        filter: (call) => {
          const date = new Date(call.createdAt);
          return date >= startOfToday;
        },
      },
      {
        id: 'yesterday',
        label: t('sweep.weldcrm.notesView.yesterday'),
        sortOrder: 2,
        filter: (call) => {
          const date = new Date(call.createdAt);
          return date >= startOfYesterday && date < startOfToday;
        },
      },
      {
        id: 'this-week',
        label: t('sweep.weldcrm.callsSection.thisWeek'),
        sortOrder: 3,
        filter: (call) => {
          const date = new Date(call.createdAt);
          return date >= startOfWeek && date < startOfYesterday;
        },
      },
      {
        id: 'older',
        label: t('sweep.weldcrm.notesView.older'),
        sortOrder: 4,
        filter: (call) => {
          const date = new Date(call.createdAt);
          return date < startOfWeek;
        },
      },
    ];
  }, [t]);

  // Apply filters
  const applyFilters = useCallback((items: CallItem[], filters: ActiveFilter[]) => {
    let result = items;

    filters.forEach(filter => {
      if (!filter.operator || !filter.value) return;

      if (filter.field === 'direction') {
        result = filter.operator === 'is'
          ? result.filter(c => c.computedDirection === filter.value)
          : result.filter(c => c.computedDirection !== filter.value);
      } else if (filter.field === 'status') {
        result = filter.operator === 'is'
          ? result.filter(c => c.computedStatus === filter.value)
          : result.filter(c => c.computedStatus !== filter.value);
      }
    });

    return result;
  }, []);

  // Header columns — adapted for panel width
  const headerColumns: HeaderColumn[] = useMemo(() => [
    { id: 'direction', header: t('sweep.weldcrm.callsSection.direction'), width: 'w-[110px]' },
    { id: 'subject', header: t('sweep.weldcrm.callsSection.subject'), width: 'flex-1 min-w-0' },
    { id: 'duration', header: t('sweep.weldcrm.callsSection.duration'), width: 'w-[90px]' },
    { id: 'status', header: t('sweep.weldcrm.callsSection.status'), width: 'w-[110px]' },
    { id: 'date', header: t('sweep.weldcrm.notesView.created'), width: 'w-[130px]' },
  ], [t]);

  // Row renderer
  const renderCallRow = useCallback((call: CallItem) => {
    const direction = call.computedDirection;
    const DirectionIcon = direction === 'inbound' ? PhoneIncoming
      : direction === 'missed' ? PhoneMissed
      : PhoneOutgoing;
    const directionColor = direction === 'inbound' ? 'text-green-600'
      : direction === 'missed' ? 'text-red-500'
      : 'text-blue-600';
    const directionLabel = direction === 'inbound' ? t('sweep.weldcrm.callsSection.inbound')
      : direction === 'missed' ? t('sweep.weldcrm.callsSection.missed')
      : t('sweep.weldcrm.callsSection.outbound');
    const status = call.computedStatus;

    return (
      <div
        key={call.id}
        className="flex items-center gap-4 px-4 py-3 border-b border-border/70 group cursor-pointer hover:bg-muted/50"
      >
        {/* Direction */}
        <div className="w-[110px] flex items-center gap-2 flex-shrink-0">
          <DirectionIcon className={cn("h-4 w-4", directionColor)} />
          <span className="text-sm text-foreground">{directionLabel}</span>
        </div>

        {/* Subject */}
        <div className="flex-1 min-w-0">
          <span className="text-sm font-medium text-foreground truncate block">
            {call.subject || t('sweep.weldcrm.callsSection.directionCall', { direction: directionLabel })}
          </span>
          {call.description && (
            <span className="text-xs text-muted-foreground truncate block mt-0.5">
              {call.description}
            </span>
          )}
        </div>

        {/* Duration */}
        <div className="w-[90px] flex items-center gap-1 text-sm text-muted-foreground flex-shrink-0">
          <Clock className="h-3.5 w-3.5" />
          <span>{formatDuration(call.callDuration)}</span>
        </div>

        {/* Status */}
        <div className="w-[110px] flex-shrink-0">
          <Badge className={cn("text-xs font-medium rounded-md border-transparent", statusConfig[status]?.color || 'bg-muted text-foreground')}>
            {statusConfig[status]?.label || status || t('sweep.weldcrm.customerDetailSidebar.unknown')}
          </Badge>
        </div>

        {/* Date */}
        <div className="w-[130px] flex-shrink-0">
          <span className="text-sm text-muted-foreground">
            {formatDistanceToNow(new Date(call.createdAt), { addSuffix: true })}
          </span>
        </div>

        {/* Actions */}
        <div className="w-[40px] flex justify-end flex-shrink-0" onClick={(e) => e.stopPropagation()}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100 data-[state=open]:bg-accent">
                <EllipsisVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem>
                <FileText className="h-4 w-4 mr-0.5" />
                {t('sweep.weldcrm.callsSection.viewDetails')}
              </DropdownMenuItem>
              {call.callRecordingUrl && (
                <DropdownMenuItem>
                  <Play className="h-4 w-4 mr-0.5" />
                  {t('sweep.weldcrm.callsSection.playRecording')}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem>
                <Link2 className="h-4 w-4 mr-0.5" />
                {t('sweep.weldcrm.callsSection.linkToCrm')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-red-600 hover:!bg-red-50 hover:!text-red-600 dark:text-red-400 dark:hover:!bg-red-950 dark:hover:!text-red-400">
                <Trash2 className="h-4 w-4 mr-0.5 text-red-600 dark:text-red-400" />
                {t('sweep.weldcrm.customerDetailSidebar.delete')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    );
  }, [t, statusConfig]);

  const handleMakeCall = useCallback(() => {
    const phone = customer.phone || customer.mobile;
    if (phone && onCall) {
      onCall(phone);
    } else {
      setIsDialerOpen(true);
    }
  }, [customer, onCall, setIsDialerOpen]);

  return (
    <EntityList<CallItem>
      items={calls}
      isLoading={false}
      error={null}
      headerColumns={headerColumns}
      filters={filterConfigs}
      groups={groupConfigs}
      maxFilters={3}
      applyFilters={applyFilters}
      renderRow={renderCallRow}
      searchPlaceholder={t('sweep.weldcrm.callsSection.searchCalls')}
      searchFields={['subject', 'description']}
      emptyStateClassName="pb-24"
      createButton={{
        label: t('sweep.weldcrm.callsSection.makeCall'),
        onClick: handleMakeCall,
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
        title: t('sweep.weldcrm.callsSection.noCallsLogged'),
        description: t('sweep.weldcrm.callsSection.noCallsLoggedDescription'),
        action: {
          label: t('sweep.weldcrm.callsSection.makeCall'),
          onClick: handleMakeCall,
        },
      }}
      noResultsState={{
        title: t('sweep.weldcrm.callsSection.noCallsFound'),
        description: t('sweep.weldcrm.callsSection.noCallsFoundDescription'),
      }}
    />
  );
}
