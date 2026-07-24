
import { useState, useCallback } from 'react';
import { useTranslations } from '@weldsuite/i18n/client';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { useRef, useEffect } from 'react';
import {
  EllipsisVertical,
  Pause,
  Play,
  UserMinus,
  Search,
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  Clock,
  Mail,
  Reply,
  XCircle,
  CircleDot,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import {
  useSequenceEnrollments,
  usePauseEnrollment,
  useResumeEnrollment,
  useUnenrollCustomer,
} from '@/hooks/queries/use-sequences-queries';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@weldsuite/ui/components/popover';
import { Toggle } from '@weldsuite/ui/components/toggle';
import { EnrollCustomersDialog } from './enroll-customers-dialog';
import { EmptyStateIllustration } from '@/components/entity-list';
import type { SequenceEnrollment, PaginationMeta } from '@/lib/api/domains/weldcrm';

interface PeopleTabProps {
  sequenceId: string;
  sequenceStatus: string;
  initialEnrollments: SequenceEnrollment[];
  initialPagination?: PaginationMeta;
}

const statusIcons: Record<string, { icon: typeof CheckCircle2; color: string }> = {
  active: { icon: Clock, color: 'text-blue-500' },
  completed: { icon: CheckCircle2, color: 'text-green-500' },
  paused: { icon: Pause, color: 'text-yellow-500' },
  failed: { icon: XCircle, color: 'text-red-500' },
  pending: { icon: CircleDot, color: 'text-purple-500' },
  unenrolled: { icon: UserMinus, color: 'text-gray-400' },
};

const statusLabels: Record<string, string> = {
  active: 'Automated email',
  completed: 'Completed',
  paused: 'Paused',
  failed: 'Failed',
  pending: 'Pending',
  unenrolled: 'Unenrolled',
};

function getCustomerName(enrollment: SequenceEnrollment): string {
  return (
    enrollment.customerFullName ||
    enrollment.customerCompanyName ||
    [enrollment.customerFirstName, enrollment.customerLastName].filter(Boolean).join(' ') ||
    enrollment.customerEmail ||
    'Unknown'
  );
}

const AVATAR_COLORS = [
  '#4F46E5', '#7C3AED', '#EC4899', '#EF4444', '#F97316',
  '#EAB308', '#22C55E', '#14B8A6', '#06B6D4', '#3B82F6',
];

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(hash);
}

function getAvatarColor(name: string): string {
  return AVATAR_COLORS[hashString(name) % AVATAR_COLORS.length];
}

export function PeopleTab({
  sequenceId,
  initialEnrollments,
  initialPagination,
}: PeopleTabProps) {
  const t = useTranslations();

  const getStatusDescription = useCallback((enrollment: SequenceEnrollment): string => {
    if (enrollment.status === 'active' && enrollment.totalSteps > 0) {
      const remaining = enrollment.totalSteps - enrollment.currentStepIndex;
      if (remaining > 0) {
        return remaining !== 1
          ? t('crm.peopleTab.statusDescActivePlural', { remaining })
          : t('crm.peopleTab.statusDescActive', { remaining });
      }
    }
    if (enrollment.status === 'completed') return t('crm.peopleTab.statusDescCompleted');
    if (enrollment.status === 'paused') return t('crm.peopleTab.statusDescPaused');
    if (enrollment.status === 'failed') return enrollment.errorMessage || t('crm.peopleTab.statusFailed');
    if (enrollment.status === 'pending') return t('crm.peopleTab.statusDescPending');
    if (enrollment.status === 'unenrolled') return t('crm.peopleTab.statusDescUnenrolled');
    return statusLabels[enrollment.status] || enrollment.status;
  }, [t]);

  const formatRelativeTime = useCallback((date?: string | null): string => {
    if (!date) return '';
    const now = new Date();
    const d = new Date(date);
    const diffMs = now.getTime() - d.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return t('crm.peopleTab.relativeTimeJustNow');
    if (diffMins < 60) return diffMins !== 1 ? t('crm.peopleTab.relativeTimeMinutesPlural', { count: diffMins }) : t('crm.peopleTab.relativeTimeMinutes', { count: diffMins });
    if (diffHours < 24) return diffHours !== 1 ? t('crm.peopleTab.relativeTimeHoursPlural', { count: diffHours }) : t('crm.peopleTab.relativeTimeHours', { count: diffHours });
    if (diffDays < 30) return diffDays !== 1 ? t('crm.peopleTab.relativeTimeDaysPlural', { count: diffDays }) : t('crm.peopleTab.relativeTimeDays', { count: diffDays });
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }, [t]);

  const [showEnrollDialog, setShowEnrollDialog] = useState(false);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  const filters = {
    page,
    pageSize: 25,
    status: statusFilter !== 'all' ? statusFilter : undefined,
    search: search.trim() || undefined,
  };

  const { data: enrollmentsData, isLoading, refetch } = useSequenceEnrollments(sequenceId, filters);

  const enrollments = enrollmentsData?.data ?? initialEnrollments;
  const pagination = enrollmentsData?.pagination ?? initialPagination;

  const pauseEnrollmentMut = usePauseEnrollment();
  const resumeEnrollmentMut = useResumeEnrollment();
  const unenrollCustomerMut = useUnenrollCustomer();

  const selectedEnrollment = enrollments.find((e) => e.id === selectedId) || null;

  const handlePause = async (enrollmentId: string) => {
    try {
      await pauseEnrollmentMut.mutateAsync({ sequenceId, enrollmentId });
      toast.success(t('crm.peopleTab.pausedSuccess'));
    } catch {
      toast.error(t('crm.peopleTab.pauseFailed'));
    }
  };

  const handleResume = async (enrollmentId: string) => {
    try {
      await resumeEnrollmentMut.mutateAsync({ sequenceId, enrollmentId });
      toast.success(t('crm.peopleTab.resumedSuccess'));
    } catch {
      toast.error(t('crm.peopleTab.resumeFailed'));
    }
  };

  const handleUnenroll = async (enrollmentId: string) => {
    if (!confirm(t('crm.peopleTab.confirmUnenroll'))) return;
    try {
      await unenrollCustomerMut.mutateAsync({ sequenceId, enrollmentId });
      toast.success(t('crm.peopleTab.unenrolledSuccess'));
    } catch {
      toast.error(t('crm.peopleTab.unenrollFailed'));
    }
  };

  const handleEnrollComplete = () => {
    setShowEnrollDialog(false);
    refetch();
  };

  return (
    <div className="flex h-full">
      {/* Left panel — Recipients list */}
      <div className="w-[419px] border-r border-border bg-white dark:bg-background flex flex-col flex-shrink-0 overflow-hidden">
        {/* Header — matches mail conversation list header */}
        <div className="flex items-center justify-between gap-2 px-4 h-[53px] border-b border-border flex-shrink-0">
          <div className="flex items-center gap-2">
            <Popover open={filterOpen} onOpenChange={setFilterOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  className={cn(
                    'h-8 text-sm px-3 shadow-none gap-1.5',
                    statusFilter !== 'all' ? 'text-foreground' : 'text-muted-foreground'
                  )}
                >
                  {t('crm.peopleTab.filterButton')}
                  {statusFilter !== 'all' && (
                    <span className="inline-flex items-center justify-center size-5 text-[10px] font-mono font-medium text-muted-foreground bg-muted border border-border rounded-md">
                      1
                    </span>
                  )}
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-[272px] p-0">
                <div className="px-3 py-3">
                  <p className="text-xs font-medium text-muted-foreground mb-2">Status</p>
                  <div className="flex flex-wrap gap-1.5">
                    {[
                      { key: 'active', label: t('crm.peopleTab.statusActive') },
                      { key: 'pending', label: t('crm.peopleTab.statusPending') },
                      { key: 'completed', label: t('crm.peopleTab.statusCompleted') },
                      { key: 'paused', label: t('crm.peopleTab.statusPaused') },
                      { key: 'failed', label: t('crm.peopleTab.statusFailed') },
                      { key: 'unenrolled', label: t('crm.peopleTab.statusUnenrolled') },
                    ].map(({ key, label }) => (
                      <Toggle
                        key={key}
                        size="sm"
                        variant="outline"
                        pressed={statusFilter === key}
                        onPressedChange={(pressed) => {
                          setStatusFilter(pressed ? key : 'all');
                          setPage(1);
                        }}
                        className="h-7 px-2.5 text-xs shadow-none data-[state=on]:bg-primary data-[state=on]:text-primary-foreground data-[state=on]:border-primary"
                      >
                        {label}
                      </Toggle>
                    ))}
                  </div>
                </div>
              </PopoverContent>
            </Popover>
          </div>

          <div className="flex-1 flex items-center justify-end gap-2">
            {/* Search */}
            <div
              className="flex items-center overflow-hidden transition-[width] duration-200 ease-out"
              style={{ width: searchOpen ? 'calc(100% - 96px)' : '32px' }}
            >
              {!searchOpen ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 w-8 p-0 flex-shrink-0 shadow-none"
                  onClick={() => setSearchOpen(true)}
                >
                  <Search className="h-4 w-4" />
                </Button>
              ) : (
                <div className="relative w-full">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <input
                    ref={searchInputRef}
                    type="text"
                    placeholder={t('crm.peopleTab.searchPlaceholder')}
                    value={search}
                    onChange={(e) => { setSearch(e.target.value); setPage(1); }}
                    onBlur={() => !search && setSearchOpen(false)}
                    className="h-8 w-full pl-8 pr-3 text-sm border border-border rounded-md bg-background focus:outline-none"
                  />
                </div>
              )}
            </div>

            {/* Enroll Button */}
            <Button
              size="sm"
              className="h-8 bg-primary text-primary-foreground hover:bg-primary/90 flex-shrink-0"
              onClick={() => setShowEnrollDialog(true)}
            >
              {t('crm.peopleTab.enrollButton')}
            </Button>
          </div>
        </div>

        {/* List */}
        <div
          className={cn('flex-1 overflow-y-auto px-1 md:px-0', isLoading && 'opacity-50')}
          style={{ scrollbarWidth: 'thin', scrollbarColor: 'rgba(156, 163, 175, 0.3) transparent' }}
        >
          {enrollments.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center text-center px-6">
              <h3 className="text-sm font-medium text-foreground mb-1">{t('crm.peopleTab.emptyTitle')}</h3>
              <p className="text-xs text-muted-foreground">
                {t('crm.peopleTab.emptyDescription')}
              </p>
            </div>
          ) : (
            enrollments.map((enrollment) => {
              const name = getCustomerName(enrollment);
              const StatusIcon = statusIcons[enrollment.status]?.icon || CircleDot;
              const statusColor = statusIcons[enrollment.status]?.color || 'text-gray-400';
              const isSelected = selectedId === enrollment.id;

              return (
                <div
                  key={enrollment.id}
                  onClick={() => setSelectedId(enrollment.id)}
                  className={cn(
                    'block border-b border-gray-100 dark:border-border transition-colors cursor-pointer',
                    isSelected ? 'bg-accent' : 'hover:bg-gray-50 dark:hover:bg-secondary'
                  )}
                >
                  <div className="px-3 md:px-4 py-3">
                    <div className="flex items-start gap-2.5">
                      {/* Avatar */}
                      <div className="relative flex-shrink-0 mt-[3px]">
                        <div
                          className="w-7 h-7 rounded-[10px] flex items-center justify-center text-white font-semibold text-xs"
                          style={{ backgroundColor: getAvatarColor(name) }}
                        >
                          {(name || '?').charAt(0).toUpperCase()}
                        </div>
                      </div>

                      {/* Content */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-medium text-gray-900 dark:text-foreground truncate">
                            {name}
                          </span>
                          <span className="text-[11px] text-gray-400 dark:text-muted-foreground flex-shrink-0">
                            {formatRelativeTime(enrollment.enrolledAt)}
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5 mt-px">
                          <StatusIcon className={cn('h-3 w-3 flex-shrink-0', statusColor)} />
                          <span className="text-[13px] text-gray-400 dark:text-muted-foreground truncate">
                            {getStatusDescription(enrollment)}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Pagination */}
        {pagination && pagination.totalPages > 1 && (
          <div className="flex-shrink-0 border-t border-gray-200 dark:border-border px-3 md:px-4 py-2.5 md:py-3 bg-white dark:bg-background">
            <div className="flex items-center justify-between">
              <div className="text-xs text-gray-500 dark:text-muted-foreground">
                <span className="hidden md:inline">
                  {((pagination.page - 1) * 25) + 1}-{Math.min(pagination.page * 25, pagination.totalCount)} of {pagination.totalCount}
                </span>
                <span className="md:hidden">{pagination.page}/{pagination.totalPages}</span>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  disabled={pagination.page <= 1}
                  onClick={() => setPage(pagination.page - 1)}
                  className="h-8 w-8 p-0"
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  disabled={!pagination.hasMore}
                  onClick={() => setPage(pagination.page + 1)}
                  className="h-8 w-8 p-0"
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Right panel — Activity timeline */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {selectedEnrollment ? (
          <>
            {/* Person header */}
            <div className="flex items-center justify-between px-6 border-b border-border h-[53px]">
              <div className="flex items-center gap-3">
                <div
                  className="w-7 h-7 rounded-[10px] flex items-center justify-center text-white font-semibold text-[10px]"
                  style={{ backgroundColor: getAvatarColor(getCustomerName(selectedEnrollment)) }}
                >
                  {(getCustomerName(selectedEnrollment) || '?').charAt(0).toUpperCase()}
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-[15px] font-medium text-foreground">
                      {getCustomerName(selectedEnrollment)}
                    </span>
                    {selectedEnrollment.customerEmail && (
                      <span className="text-xs text-muted-foreground">
                        {selectedEnrollment.customerEmail}
                      </span>
                    )}
                  </div>
                </div>
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-8 w-8">
                    <EllipsisVertical className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {selectedEnrollment.status === 'active' && (
                    <DropdownMenuItem onClick={() => handlePause(selectedEnrollment.id)}>
                      <Pause className="h-4 w-4 mr-2" />
                      {t('crm.peopleTab.menuPause')}
                    </DropdownMenuItem>
                  )}
                  {selectedEnrollment.status === 'paused' && (
                    <DropdownMenuItem onClick={() => handleResume(selectedEnrollment.id)}>
                      <Play className="h-4 w-4 mr-2" />
                      {t('crm.peopleTab.menuResume')}
                    </DropdownMenuItem>
                  )}
                  {(selectedEnrollment.status === 'active' || selectedEnrollment.status === 'paused') && (
                    <DropdownMenuItem
                      className="text-red-600"
                      onClick={() => handleUnenroll(selectedEnrollment.id)}
                    >
                      <UserMinus className="h-4 w-4 mr-2" />
                      {t('crm.peopleTab.menuUnenroll')}
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            {/* Timeline — matches helpdesk activity timeline */}
            <div className="flex-1 overflow-auto px-6 py-6">
              <div>
                {(() => {
                  const name = getCustomerName(selectedEnrollment);
                  const events: Array<{
                    id: string;
                    type: 'enrolled' | 'email' | 'completed' | 'unenrolled' | 'failed' | 'paused';
                    text: string;
                    author?: string;
                    timestamp: string;
                    detail?: string;
                  }> = [];

                  // Enrolled event
                  events.push({
                    id: 'enrolled',
                    type: 'enrolled',
                    text: t('crm.peopleTab.timelineEnrolledEvent', { name }),
                    author: name,
                    timestamp: selectedEnrollment.enrolledAt,
                  });

                  // Step events
                  for (let i = 0; i < selectedEnrollment.currentStepIndex; i++) {
                    events.push({
                      id: `step-${i}`,
                      type: 'email',
                      text: t('crm.peopleTab.timelineAutomatedEmail'),
                      timestamp: selectedEnrollment.enrolledAt,
                      detail: t('crm.peopleTab.timelineStepCompleted', { step: i + 1 }),
                    });
                  }

                  // Terminal events
                  if (selectedEnrollment.status === 'completed' && selectedEnrollment.completedAt) {
                    events.push({
                      id: 'completed',
                      type: 'completed',
                      text: t('crm.peopleTab.timelineCompletedSequence', { name }),
                      timestamp: selectedEnrollment.completedAt,
                    });
                  }
                  if (selectedEnrollment.status === 'unenrolled' && selectedEnrollment.unenrolledAt) {
                    events.push({
                      id: 'unenrolled',
                      type: 'unenrolled',
                      text: t('crm.peopleTab.timelineExitedSequence', { name }),
                      timestamp: selectedEnrollment.unenrolledAt,
                    });
                  }
                  if (selectedEnrollment.status === 'failed') {
                    events.push({
                      id: 'failed',
                      type: 'failed',
                      text: selectedEnrollment.errorMessage
                        ? t('crm.peopleTab.timelineSequenceFailed', { message: selectedEnrollment.errorMessage })
                        : t('crm.peopleTab.timelineSequenceFailedNoMsg'),
                      timestamp: selectedEnrollment.failedAt || selectedEnrollment.enrolledAt,
                    });
                  }
                  if (selectedEnrollment.status === 'paused' && selectedEnrollment.pausedAt) {
                    events.push({
                      id: 'paused',
                      type: 'paused',
                      text: t('crm.peopleTab.timelinePaused', { name }),
                      timestamp: selectedEnrollment.pausedAt,
                    });
                  }

                  return events.map((event, index) => {
                    const isLast = index === events.length - 1;
                    const isNoteType = event.type === 'enrolled' || event.type === 'email';

                    if (isNoteType) {
                      return (
                        <div key={event.id} className="flex">
                          {/* Tree connector */}
                          <div className="relative flex-shrink-0" style={{ width: 20 }}>
                            <div
                              className={cn(
                                'relative z-10 w-5 h-5 rounded-md flex items-center justify-center text-white text-[9px] font-semibold',
                                event.type === 'enrolled' ? 'bg-emerald-500' : 'bg-blue-500'
                              )}
                              style={{ marginTop: 0 }}
                            >
                              {event.type === 'enrolled'
                                ? (event.author || '?').charAt(0).toUpperCase()
                                : <Mail className="w-2.5 h-2.5 text-white" />
                              }
                            </div>
                            {!isLast && (
                              <div className="absolute bg-border" style={{ left: 9, top: 25, bottom: 5, width: 1 }} />
                            )}
                          </div>

                          {/* Content */}
                          <div className={cn('flex-1 min-w-0 pl-2.5', isLast ? '' : 'pb-7')}>
                            <div className="flex items-baseline gap-1.5 mb-[7px]">
                              {event.type === 'enrolled' ? (
                                <>
                                  <span className="text-[14px] font-medium text-foreground">{event.author}</span>
                                  <span className="text-[14px] text-muted-foreground">{t('crm.peopleTab.timelineEnrolled')}</span>
                                </>
                              ) : (
                                <span className="text-[14px] font-medium text-foreground">{t('crm.peopleTab.timelineAutomatedEmail')}</span>
                              )}
                              <span className="flex-1" />
                              <span className="text-[12px] text-muted-foreground/60 flex-shrink-0">
                                {formatRelativeTime(event.timestamp)}
                              </span>
                            </div>
                            {event.detail && (
                              <div className="rounded-lg border border-border px-3 py-2">
                                <p className="text-[14px] leading-relaxed text-foreground whitespace-pre-wrap">
                                  {event.detail}
                                </p>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    }

                    // System event (completed, unenrolled, failed, paused)
                    const iconMap = {
                      completed: <CheckCircle2 className="w-2.5 h-2.5 text-muted-foreground" />,
                      unenrolled: <Reply className="w-2.5 h-2.5 text-muted-foreground" />,
                      failed: <XCircle className="w-2.5 h-2.5 text-muted-foreground" />,
                      paused: <Pause className="w-2.5 h-2.5 text-muted-foreground" />,
                    };

                    return (
                      <div key={event.id} className="flex">
                        {/* Tree connector */}
                        <div className="relative flex-shrink-0" style={{ width: 20 }}>
                          <div className="relative z-10 w-5 h-5 rounded-md flex items-center justify-center bg-muted" style={{ marginTop: 3 }}>
                            {iconMap[event.type as keyof typeof iconMap]}
                          </div>
                          {!isLast && (
                            <div className="absolute bg-border" style={{ left: 9, top: 28, bottom: 5, width: 1 }} />
                          )}
                        </div>

                        {/* Content */}
                        <div className={cn('flex-1 min-w-0 pl-2.5 flex items-start pt-0.5', isLast ? '' : 'pb-7')}>
                          <p className="flex-1 text-[14px] text-muted-foreground">
                            {event.text}
                          </p>
                          <span className="text-[12px] text-muted-foreground/60 flex-shrink-0 ml-3">
                            {formatRelativeTime(event.timestamp)}
                          </span>
                        </div>
                      </div>
                    );
                  });
                })()}
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="flex flex-col items-center text-center">
              <EmptyStateIllustration>
                <svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <line x1="38" y1="20" x2="38" y2="100" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="1" strokeDasharray="4 3" />
                  <circle cx="38" cy="30" r="4" className="fill-white dark:fill-white/[0.03] stroke-gray-300 dark:stroke-white/20" strokeWidth="1.5" />
                  <rect x="50" y="28" width="36" height="3" rx="1.5" className="fill-gray-200 dark:fill-white/20" opacity="0.6" />
                  <circle cx="38" cy="52" r="4" className="fill-white dark:fill-white/[0.03] stroke-gray-300 dark:stroke-white/20" strokeWidth="1.5" />
                  <rect x="50" y="50" width="28" height="3" rx="1.5" className="fill-gray-200 dark:fill-white/20" opacity="0.5" />
                  <circle cx="38" cy="74" r="4" className="fill-white dark:fill-white/[0.03] stroke-gray-300 dark:stroke-white/20" strokeWidth="1.5" />
                  <rect x="50" y="72" width="32" height="3" rx="1.5" className="fill-gray-200 dark:fill-white/20" opacity="0.4" />
                  <circle cx="38" cy="96" r="4" className="fill-white dark:fill-white/[0.03] stroke-gray-200 dark:stroke-white/15" strokeWidth="1.5" />
                  <rect x="50" y="94" width="24" height="3" rx="1.5" className="fill-gray-200 dark:fill-white/20" opacity="0.3" />
                </svg>
              </EmptyStateIllustration>
              <h3 className="text-base font-semibold text-foreground mb-1">{t('crm.peopleTab.noRecipientSelectedTitle')}</h3>
              <p className="text-sm text-muted-foreground">
                {t('crm.peopleTab.noRecipientSelectedDescription')}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Enroll Dialog */}
      <EnrollCustomersDialog
        open={showEnrollDialog}
        onOpenChange={setShowEnrollDialog}
        sequenceId={sequenceId}
        onComplete={handleEnrollComplete}
      />
    </div>
  );
}
