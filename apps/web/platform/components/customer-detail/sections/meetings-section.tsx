
import { useCallback, useMemo, useState } from 'react';
import { useRouter } from '@/lib/router';
import { Button } from '@weldsuite/ui/components/button';
import { Badge } from '@weldsuite/ui/components/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import {
  Play,
  Video,
  Download,
  User,
  Briefcase,
  Link2,
  EllipsisVertical,
  ExternalLink,
  Trash2,
  Clock,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { EntityList, EmptyStateIllustration, type HeaderColumn, type FilterConfig, type GroupConfig, type ActiveFilter } from '@/components/entity-list';
import { cn } from '@/lib/utils';
import type { SectionProps } from '../types';
import { useTranslations } from '@weldsuite/i18n/client';

// Unified recording type
interface MeetingRecording {
  id: string;
  type: 'bot' | 'call';
  title: string;
  platform?: string;
  status?: string;
  duration?: number;
  recordingUrl?: string;
  contactName?: string;
  opportunityName?: string;
  createdAt: string;
  isLive?: boolean;
}

function getPlatformIcon(platform?: string | null) {
  if (!platform) return <Video className="h-4 w-4 text-muted-foreground" />;
  switch (platform.toLowerCase()) {
    case 'googlemeet':
    case 'google_meet':
      return <img src="/logos/google-meet.png" alt="Google Meet" className="h-4 w-4" />;
    case 'teams':
    case 'microsoft_teams':
      return <img src="/logos/teams.svg" alt="Microsoft Teams" className="h-4 w-4" />;
    case 'zoom':
      return <img src="/logos/zoom.svg" alt="Zoom" className="h-4 w-4" />;
    default:
      return <Video className="h-4 w-4 text-muted-foreground" />;
  }
}

function getPlatformName(platform: string | null | undefined, t: (key: string) => string) {
  if (!platform) return t('sweep.weldcrm.customerDetailSidebar.unknown');
  switch (platform.toLowerCase()) {
    case 'googlemeet':
    case 'google_meet':
      return 'Google Meet';
    case 'teams':
    case 'microsoft_teams':
      return 'Teams';
    case 'zoom':
      return 'Zoom';
    default:
      return platform;
  }
}

function formatDuration(seconds?: number) {
  if (!seconds) return '--:--';
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m ${secs}s`;
}

// `customer` isn't read here, but the parameter must stay to match the
// shared `SectionProps` contract every `<XSection customer={...} />` caller uses.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function MeetingsSection(_props: SectionProps) {
  const t = useTranslations();
  const router = useRouter();
  const [recordings] = useState<MeetingRecording[]>([]);

  // Status configuration
  const statusConfig: Record<string, { label: string; color: string }> = useMemo(() => ({
    'pending': { label: t('sweep.weldcrm.meetingsSection.statusPending'), color: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400' },
    'connecting': { label: t('sweep.weldcrm.meetingsSection.statusConnecting'), color: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400' },
    'joining': { label: t('sweep.weldcrm.meetingsSection.statusJoining'), color: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400' },
    'connected': { label: t('sweep.weldcrm.meetingsSection.statusRecording'), color: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400' },
    'recording': { label: t('sweep.weldcrm.meetingsSection.statusRecording'), color: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400' },
    'completed': { label: t('sweep.weldcrm.callsSection.statusCompleted'), color: 'bg-muted text-muted-foreground' },
    'left': { label: t('sweep.weldcrm.meetingsSection.statusLeft'), color: 'bg-muted text-muted-foreground' },
    'failed': { label: t('sweep.weldcrm.callsSection.statusFailed'), color: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400' },
  }), [t]);

  // Filter configs
  const filterConfigs: FilterConfig[] = useMemo(() => [
    {
      field: 'source',
      label: t('sweep.weldcrm.meetingsSection.source'),
      options: [
        { value: 'bot', label: t('sweep.weldcrm.meetingsSection.botRecording') },
        { value: 'call', label: t('sweep.weldcrm.meetingsSection.uploadedCall') },
      ],
    },
    {
      field: 'status',
      label: t('sweep.weldcrm.callsSection.status'),
      options: [
        { value: 'active', label: t('sweep.weldcrm.meetingsSection.active') },
        { value: 'completed', label: t('sweep.weldcrm.callsSection.statusCompleted') },
        { value: 'failed', label: t('sweep.weldcrm.callsSection.statusFailed') },
      ],
    },
    {
      field: 'platform',
      label: t('sweep.weldcrm.meetingsSection.platform'),
      options: [
        { value: 'googlemeet', label: 'Google Meet' },
        { value: 'teams', label: 'Teams' },
        { value: 'zoom', label: 'Zoom' },
      ],
    },
  ], [t]);

  // Group configs by date
  const groupConfigs: GroupConfig<MeetingRecording>[] = useMemo(() => {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfYesterday = new Date(startOfToday.getTime() - 24 * 60 * 60 * 1000);
    const startOfWeek = new Date(startOfToday.getTime() - 7 * 24 * 60 * 60 * 1000);

    return [
      {
        id: 'today',
        label: t('sweep.weldcrm.notesView.today'),
        sortOrder: 1,
        filter: (r) => {
          const date = r.createdAt ? new Date(r.createdAt) : null;
          return date ? date >= startOfToday : false;
        },
      },
      {
        id: 'yesterday',
        label: t('sweep.weldcrm.notesView.yesterday'),
        sortOrder: 2,
        filter: (r) => {
          const date = r.createdAt ? new Date(r.createdAt) : null;
          return date ? date >= startOfYesterday && date < startOfToday : false;
        },
      },
      {
        id: 'this-week',
        label: t('sweep.weldcrm.callsSection.thisWeek'),
        sortOrder: 3,
        filter: (r) => {
          const date = r.createdAt ? new Date(r.createdAt) : null;
          return date ? date >= startOfWeek && date < startOfYesterday : false;
        },
      },
      {
        id: 'older',
        label: t('sweep.weldcrm.notesView.older'),
        sortOrder: 4,
        filter: (r) => {
          const date = r.createdAt ? new Date(r.createdAt) : null;
          return date ? date < startOfWeek : !r.createdAt;
        },
      },
    ];
  }, [t]);

  // Apply filters
  const applyFilters = useCallback((items: MeetingRecording[], filters: ActiveFilter[]) => {
    let result = items;

    filters.forEach(filter => {
      if (!filter.operator || !filter.value) return;

      if (filter.field === 'source') {
        result = filter.operator === 'is'
          ? result.filter(r => r.type === filter.value)
          : result.filter(r => r.type !== filter.value);
      } else if (filter.field === 'status') {
        if (filter.value === 'active') {
          result = filter.operator === 'is'
            ? result.filter(r => r.isLive)
            : result.filter(r => !r.isLive);
        } else {
          result = filter.operator === 'is'
            ? result.filter(r => r.status?.toLowerCase() === filter.value)
            : result.filter(r => r.status?.toLowerCase() !== filter.value);
        }
      } else if (filter.field === 'platform') {
        result = filter.operator === 'is'
          ? result.filter(r => r.platform?.toLowerCase().includes(filter.value))
          : result.filter(r => !r.platform?.toLowerCase().includes(filter.value));
      }
    });

    return result;
  }, []);

  // Header columns — adapted for panel width
  const headerColumns: HeaderColumn[] = useMemo(() => [
    { id: 'title', header: t('sweep.weldcrm.meetingsSection.title'), width: 'flex-1 min-w-0' },
    { id: 'platform', header: t('sweep.weldcrm.meetingsSection.platform'), width: 'w-[120px]' },
    { id: 'status', header: t('sweep.weldcrm.callsSection.status'), width: 'w-[110px]' },
    { id: 'duration', header: t('sweep.weldcrm.callsSection.duration'), width: 'w-[90px]' },
    { id: 'date', header: t('sweep.weldcrm.notesView.created'), width: 'w-[130px]' },
  ], [t]);

  // Render row
  const renderRow = useCallback((recording: MeetingRecording) => {
    const isBotRecording = recording.type === 'bot';
    const status = recording.status?.toLowerCase() || '';
    const hasRecording = recording.recordingUrl && status === 'completed';

    return (
      <div
        key={recording.id}
        className="flex items-center gap-4 px-4 py-3 border-b border-border/70 group cursor-pointer hover:bg-muted/50"
        onClick={() => {
          if (isBotRecording) {
            router.push(`/weldmeet/${recording.id.replace('bot-', '')}`);
          } else {
            router.push(`/weldcall/${recording.id.replace('call-', '')}`);
          }
        }}
      >
        {/* Title */}
        <div className="flex-1 min-w-0 flex items-center gap-3">
          <div className="flex-shrink-0 flex items-center justify-center h-8 w-8 rounded-lg bg-muted">
            <Video className="h-4 w-4 text-muted-foreground" />
          </div>
          <div className="min-w-0">
            <span className="text-sm font-medium text-foreground truncate block">
              {recording.title}
            </span>
            {(recording.contactName || recording.opportunityName) && (
              <div className="flex items-center gap-2 mt-0.5">
                {recording.contactName && (
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <User className="h-3 w-3" />
                    {recording.contactName}
                  </span>
                )}
                {recording.opportunityName && (
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Briefcase className="h-3 w-3" />
                    {recording.opportunityName}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Platform */}
        <div className="w-[120px] flex items-center gap-2 flex-shrink-0">
          {getPlatformIcon(recording.platform)}
          <span className="text-sm text-muted-foreground">{getPlatformName(recording.platform, t)}</span>
        </div>

        {/* Status */}
        <div className="w-[110px] flex-shrink-0">
          <div className="flex items-center gap-1.5">
            <Badge className={cn("text-xs font-medium rounded-md border-transparent", statusConfig[status]?.color || 'bg-muted text-foreground')}>
              {recording.isLive ? t('sweep.weldcrm.meetingsSection.live') : statusConfig[status]?.label || recording.status || t('sweep.weldcrm.customerDetailSidebar.unknown')}
            </Badge>
            {recording.isLive && (
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
              </span>
            )}
          </div>
        </div>

        {/* Duration */}
        <div className="w-[90px] flex items-center gap-1 text-sm text-muted-foreground flex-shrink-0">
          <Clock className="h-3.5 w-3.5" />
          <span>{formatDuration(recording.duration)}</span>
        </div>

        {/* Date */}
        <div className="w-[130px] flex-shrink-0">
          {recording.createdAt ? (
            <span className="text-sm text-muted-foreground">
              {formatDistanceToNow(new Date(recording.createdAt), { addSuffix: true })}
            </span>
          ) : (
            <span className="text-sm text-muted-foreground">—</span>
          )}
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
              {isBotRecording && hasRecording && (
                <DropdownMenuItem asChild>
                  <a href={recording.recordingUrl} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="h-4 w-4 mr-0.5" />
                    {t('sweep.weldcrm.meetingsSection.openRecording')}
                  </a>
                </DropdownMenuItem>
              )}
              {!isBotRecording && (
                <DropdownMenuItem>
                  <Play className="h-4 w-4 mr-0.5" />
                  {t('sweep.weldcrm.callsSection.playRecording')}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem>
                <Link2 className="h-4 w-4 mr-0.5" />
                {t('sweep.weldcrm.callsSection.viewDetails')}
              </DropdownMenuItem>
              {!isBotRecording && (
                <DropdownMenuItem>
                  <Download className="h-4 w-4 mr-0.5" />
                  {t('sweep.weldcrm.filesSection.download')}
                </DropdownMenuItem>
              )}
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
  }, [router, t, statusConfig]);

  return (
    <EntityList<MeetingRecording>
      items={recordings}
      isLoading={false}
      error={null}
      headerColumns={headerColumns}
      filters={filterConfigs}
      groups={groupConfigs}
      maxFilters={4}
      applyFilters={applyFilters}
      renderRow={renderRow}
      searchPlaceholder={t('sweep.weldcrm.meetingsSection.searchMeetings')}
      searchFields={['title', 'contactName', 'opportunityName']}
      emptyStateClassName="pb-24"
      createButton={{
        label: t('sweep.weldcrm.meetingsSection.scheduleMeeting'),
        onClick: () => {},
      }}
      emptyState={{
        icon: (
          <EmptyStateIllustration>
            <svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
              {/* Laptop screen */}
              <rect x="18" y="18" width="84" height="56" rx="4" className="fill-white dark:fill-white/[0.03]" />
              <rect x="18" y="18" width="84" height="56" rx="4" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
              {/* Webcam dot */}
              <circle cx="60" cy="21" r="1" className="fill-gray-300 dark:fill-white/20" />
              {/* 3x2 video grid - snug inside screen with 2px gap */}
              <rect x="23" y="25" width="24" height="21" rx="2" className="fill-gray-50 dark:fill-white/[0.06] stroke-gray-100 dark:stroke-white/10" strokeWidth="0.5" />
              <rect x="49" y="25" width="24" height="21" rx="2" className="fill-gray-50 dark:fill-white/[0.06] stroke-gray-100 dark:stroke-white/10" strokeWidth="0.5" />
              <rect x="75" y="25" width="24" height="21" rx="2" className="fill-gray-50 dark:fill-white/[0.06] stroke-gray-100 dark:stroke-white/10" strokeWidth="0.5" />
              <rect x="23" y="48" width="24" height="21" rx="2" className="fill-gray-50 dark:fill-white/[0.06] stroke-gray-100 dark:stroke-white/10" strokeWidth="0.5" />
              <rect x="49" y="48" width="24" height="21" rx="2" className="fill-gray-50 dark:fill-white/[0.06] stroke-gray-100 dark:stroke-white/10" strokeWidth="0.5" />
              <rect x="75" y="48" width="24" height="21" rx="2" className="fill-gray-50 dark:fill-white/[0.06] stroke-gray-100 dark:stroke-white/10" strokeWidth="0.5" />
              {/* Person silhouettes */}
              <circle cx="35" cy="32" r="3" className="fill-gray-200 dark:fill-white/20" opacity="0.55" />
              <path d="M30 40C30 38 32 36.5 35 36.5C38 36.5 40 38 40 40V44H30V40Z" className="fill-gray-200 dark:fill-white/20" opacity="0.55" />
              <circle cx="61" cy="32" r="3" className="fill-gray-200 dark:fill-white/20" opacity="0.5" />
              <path d="M56 40C56 38 58 36.5 61 36.5C64 36.5 66 38 66 40V44H56V40Z" className="fill-gray-200 dark:fill-white/20" opacity="0.5" />
              <circle cx="87" cy="32" r="3" className="fill-gray-200 dark:fill-white/20" opacity="0.45" />
              <path d="M82 40C82 38 84 36.5 87 36.5C90 36.5 92 38 92 40V44H82V40Z" className="fill-gray-200 dark:fill-white/20" opacity="0.45" />
              <circle cx="35" cy="55" r="3" className="fill-gray-200 dark:fill-white/20" opacity="0.4" />
              <path d="M30 63C30 61 32 59.5 35 59.5C38 59.5 40 61 40 63V67H30V63Z" className="fill-gray-200 dark:fill-white/20" opacity="0.4" />
              <circle cx="61" cy="55" r="3" className="fill-gray-200 dark:fill-white/20" opacity="0.35" />
              <path d="M56 63C56 61 58 59.5 61 59.5C64 59.5 66 61 66 63V67H56V63Z" className="fill-gray-200 dark:fill-white/20" opacity="0.35" />
              <circle cx="87" cy="55" r="3" className="fill-gray-200 dark:fill-white/20" opacity="0.3" />
              <path d="M82 63C82 61 84 59.5 87 59.5C90 59.5 92 61 92 63V67H82V63Z" className="fill-gray-200 dark:fill-white/20" opacity="0.3" />
              {/* Laptop base */}
              <path d="M14 74H106V78C106 80.2 104.2 82 102 82H18C15.8 82 14 80.2 14 78V74Z" className="fill-white dark:fill-white/[0.03]" />
              <path d="M14 74H106V78C106 80.2 104.2 82 102 82H18C15.8 82 14 80.2 14 78V74Z" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="1" fill="none" />
              {/* Trackpad */}
              <rect x="50" y="77" width="20" height="1" rx="0.5" className="fill-gray-200 dark:fill-white/20" opacity="0.4" />
            </svg>
          </EmptyStateIllustration>
        ),
        title: t('sweep.weldcrm.meetingsSection.noMeetingsYet'),
        description: t('sweep.weldcrm.meetingsSection.noMeetingsYetDescription'),
        action: {
          label: t('sweep.weldcrm.meetingsSection.scheduleMeeting'),
          onClick: () => {},
        },
      }}
      noResultsState={{
        title: t('sweep.weldcrm.meetingsSection.noMeetingsFound'),
        description: t('sweep.weldcrm.meetingsSection.noMeetingsFoundDescription'),
      }}
    />
  );
}
