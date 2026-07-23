import { useState, useEffect, useMemo, useCallback, type ReactNode } from 'react';
import {
  Mic,
  MicOff,
  Video as VideoIcon,
  VideoOff,
  Check,
  Users,
} from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { Button } from '@weldsuite/ui/components/button';
import { ParticipantContextMenu } from './participant-context-menu';
import {
  Dialog,
  DialogContent,
} from '@weldsuite/ui/components/dialog';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@weldsuite/ui/components/popover';
import { cn } from '@weldsuite/ui/lib/utils';
import {
  EntityList,
  type FilterConfig,
  type GroupConfig,
  type ActiveFilter,
  type RowHandlers,
} from './entity-list';

interface PersonRow {
  id: string;
  name: string;
  picture?: string | null;
  audioEnabled: boolean;
  videoEnabled: boolean;
  status: 'in-call' | 'waiting';
  isSelf: boolean;
  raw: any;
}

export interface PeopleEntityListPanelProps {
  meeting: any;
  participants: any[];
  selfIsHost?: boolean;
  /** Workspace member-search content rendered inside the "+ Add people" dialog. */
  addPeopleDialogContent?: ReactNode;
  /**
   * Open a person's detail panel when their row is clicked. Receives the raw
   * participant object. Platform-only — omit in the portal where guests have no
   * detail panel. Self + waiting rows are never clickable.
   */
  onClickPerson?: (participant: any) => void;
}

export function PeopleEntityListPanel({
  meeting,
  participants,
  selfIsHost = true,
  addPeopleDialogContent,
  onClickPerson,
}: PeopleEntityListPanelProps) {
  const [waitlisted, setWaitlisted] = useState<any[]>([]);
  const [groupBy, setGroupBy] = useState<'status' | 'audio' | 'video' | 'none'>('status');
  const [showAddDialog, setShowAddDialog] = useState(false);
  // Right-click context menu (platform only — gated on onClickPerson).
  const [menuRow, setMenuRow] = useState<PersonRow | null>(null);
  const [menuPos, setMenuPos] = useState({ x: 0, y: 0 });

  useEffect(() => {
    if (!meeting?.participants?.waitlisted) return;
    const update = () => {
      const list = meeting.participants.waitlisted.toArray?.() ?? [];
      setWaitlisted([...list]);
    };
    update();
    meeting.participants.waitlisted.on?.('participantJoined', update);
    meeting.participants.waitlisted.on?.('participantLeft', update);
    return () => {
      meeting.participants.waitlisted.off?.('participantJoined', update);
      meeting.participants.waitlisted.off?.('participantLeft', update);
    };
  }, [meeting]);

  const handleAdmit = useCallback(async (id: string) => {
    try { await meeting?.participants?.acceptWaitingRoomRequest(id); } catch { /* ignore */ }
  }, [meeting]);

  const handleReject = useCallback(async (id: string) => {
    try { await meeting?.participants?.rejectWaitingRoomRequest(id); } catch { /* ignore */ }
  }, [meeting]);

  const handleAdmitAll = useCallback(async () => {
    const ids = waitlisted.map((p: any) => p.id);
    try { await meeting?.participants?.acceptAllWaitingRoomRequest(ids); } catch { /* ignore */ }
  }, [meeting, waitlisted]);

  const items = useMemo<PersonRow[]>(() => {
    const inCall: PersonRow[] = participants.map((p, i) => {
      const isSelf = i === 0;
      const baseName = p.name ?? (isSelf ? 'You' : 'Participant');
      return {
        id: p.id ?? `participant-${i}`,
        name: isSelf ? `You${selfIsHost ? ' (Host)' : ''}` : baseName,
        picture: p.picture ?? null,
        audioEnabled: !!p.audioEnabled,
        videoEnabled: !!p.videoEnabled,
        status: 'in-call' as const,
        isSelf,
        raw: p,
      };
    });
    const waiting: PersonRow[] = waitlisted.map((p: any) => ({
      id: p.id,
      name: p.name ?? 'Guest',
      picture: p.picture ?? null,
      audioEnabled: false,
      videoEnabled: false,
      status: 'waiting' as const,
      isSelf: false,
      raw: p,
    }));
    return [...inCall, ...waiting];
  }, [participants, waitlisted, selfIsHost]);

  const filterConfigs: FilterConfig[] = useMemo(() => [
    {
      field: 'status',
      label: 'Status',
      options: [
        { value: 'in-call', label: 'In this call' },
        { value: 'waiting', label: 'Waiting to join' },
      ],
      getDisplayValue: (v) => (v === 'in-call' ? 'In this call' : 'Waiting to join'),
    },
    {
      field: 'audio',
      label: 'Microphone',
      options: [
        { value: 'on', label: 'On' },
        { value: 'off', label: 'Off' },
      ],
    },
    {
      field: 'video',
      label: 'Camera',
      options: [
        { value: 'on', label: 'On' },
        { value: 'off', label: 'Off' },
      ],
    },
  ], []);

  const applyFilters = useCallback((rows: PersonRow[], filters: ActiveFilter[]) => {
    let result = rows;
    filters.forEach((f) => {
      if (!f.operator || !f.value) return;
      const isOp = f.operator === 'is';
      if (f.field === 'status') {
        result = result.filter((r) => (r.status === f.value) === isOp);
      } else if (f.field === 'audio') {
        const want = f.value === 'on';
        result = result.filter((r) => (r.audioEnabled === want) === isOp);
      } else if (f.field === 'video') {
        const want = f.value === 'on';
        result = result.filter((r) => (r.videoEnabled === want) === isOp);
      }
    });
    return result;
  }, []);

  const groupConfigs: GroupConfig<PersonRow>[] = useMemo(() => {
    if (groupBy === 'none') return [];
    if (groupBy === 'audio') {
      return [
        { id: 'audio-on', label: 'Microphone on', sortOrder: 1, filter: (r) => r.audioEnabled },
        { id: 'audio-off', label: 'Microphone off', sortOrder: 2, filter: (r) => !r.audioEnabled },
      ];
    }
    if (groupBy === 'video') {
      return [
        { id: 'video-on', label: 'Camera on', sortOrder: 1, filter: (r) => r.videoEnabled },
        { id: 'video-off', label: 'Camera off', sortOrder: 2, filter: (r) => !r.videoEnabled },
      ];
    }
    return [
      {
        id: 'in-call',
        label: 'In this call',
        sortOrder: 1,
        filter: (r) => r.status === 'in-call',
      },
      {
        id: 'waiting',
        label: 'Waiting to join',
        sortOrder: 2,
        filter: (r) => r.status === 'waiting',
        rightContent: waitlisted.length > 1 ? (
          <Button size="xs" variant="secondary" onClick={handleAdmitAll}>
            Admit all ({waitlisted.length})
          </Button>
        ) : undefined,
      },
    ];
  }, [groupBy, waitlisted.length, handleAdmitAll]);

  const groupByOptions = [
    { value: 'status' as const, label: 'Status' },
    { value: 'audio' as const, label: 'Microphone' },
    { value: 'video' as const, label: 'Camera' },
    { value: 'none' as const, label: 'None' },
  ];
  const groupByLabel = groupByOptions.find((o) => o.value === groupBy)?.label ?? 'Status';
  const groupByMenu = (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-8 text-sm px-3 shadow-none text-muted-foreground"
        >
          {groupByLabel}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-48 p-1">
        {groupByOptions.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => setGroupBy(opt.value)}
            className={cn(
              'w-full flex items-center justify-between px-2 py-1.5 text-sm rounded hover:bg-muted',
              groupBy === opt.value && 'bg-muted',
            )}
          >
            <span>{opt.label}</span>
            {groupBy === opt.value && <Check className="h-3.5 w-3.5" />}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );

  const renderRow = useCallback((row: PersonRow, _handlers: RowHandlers<PersonRow>) => {
    const initials = (row.name || '?').charAt(0).toUpperCase();
    const isWaiting = row.status === 'waiting';
    const clickable = !!onClickPerson && !isWaiting && !row.isSelf;
    // The context menu is enabled for any in-call row (incl. self) on platform.
    const menuEnabled = !!onClickPerson && !isWaiting;
    return (
      <div
        key={row.id}
        className={cn(
          'group flex items-center gap-3 px-4 py-3 border-b border-border/70',
          'hover:bg-gray-50 dark:hover:bg-secondary/40 transition-colors',
          clickable && 'cursor-pointer',
        )}
        onClick={clickable ? () => onClickPerson!(row.raw) : undefined}
        onContextMenu={
          menuEnabled
            ? (e) => {
                e.preventDefault();
                const menuW = 220;
                const menuH = 340;
                setMenuPos({
                  x: Math.min(e.clientX, window.innerWidth - menuW),
                  y:
                    e.clientY + menuH > window.innerHeight
                      ? Math.max(0, e.clientY - menuH)
                      : e.clientY,
                });
                setMenuRow(row);
              }
            : undefined
        }
        title={clickable ? `View ${row.name}` : undefined}
      >
        <div className="relative flex-shrink-0">
          <Avatar className="h-7 w-7 !rounded-[8px]">
            {row.picture && <AvatarImage src={row.picture} className="!rounded-[8px]" />}
            <AvatarFallback className="text-[10px] font-medium !rounded-[8px]">
              {initials}
            </AvatarFallback>
          </Avatar>
          {!isWaiting && (
            <div
              className={cn(
                'absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-background',
                // Everyone in the call has a real presence status. Fully-active
                // (mic + camera on) reads as "active" (green); otherwise they're
                // "busy — in a call" (solid amber) rather than a faint/transparent
                // dot that looks like a missing status.
                row.audioEnabled && row.videoEnabled ? 'bg-emerald-500' : 'bg-amber-500',
              )}
              title={row.audioEnabled && row.videoEnabled ? 'Active' : 'Busy — in a call'}
            />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate text-gray-900 dark:text-foreground">
            {row.name}
          </p>
        </div>
        {isWaiting ? (
          <div className="flex items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              className="text-muted-foreground"
              onClick={() => handleReject(row.id)}
            >
              Deny
            </Button>
            <Button size="sm" onClick={() => handleAdmit(row.id)}>
              Admit
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-1">
            <div
              className={cn(
                'flex h-7 w-7 items-center justify-center rounded-[8px]',
                row.audioEnabled
                  ? 'bg-muted text-muted-foreground'
                  : 'bg-red-500/10 text-red-400',
              )}
            >
              {row.audioEnabled ? (
                <Mic className="h-3.5 w-3.5" />
              ) : (
                <MicOff className="h-3.5 w-3.5" />
              )}
            </div>
            <div
              className={cn(
                'flex h-7 w-7 items-center justify-center rounded-[8px]',
                row.videoEnabled
                  ? 'bg-muted text-muted-foreground'
                  : 'bg-red-500/10 text-red-400',
              )}
            >
              {row.videoEnabled ? (
                <VideoIcon className="h-3.5 w-3.5" />
              ) : (
                <VideoOff className="h-3.5 w-3.5" />
              )}
            </div>
          </div>
        )}
      </div>
    );
  }, [handleAdmit, handleReject, onClickPerson]);

  return (
    <div className="flex flex-col min-w-0 w-full overflow-x-hidden">
      <EntityList<PersonRow>
        items={items}
        isLoading={false}
        filters={filterConfigs}
        groups={groupConfigs}
        applyFilters={applyFilters}
        searchPlaceholder="Search people..."
        searchFields={['name']}
        renderRow={renderRow}
        leftActionButtons={groupByMenu}
        createButton={addPeopleDialogContent ? {
          label: 'Add people',
          onClick: () => setShowAddDialog(true),
        } : undefined}
        emptyState={{
          icon: (
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
              <Users className="h-5 w-5 text-muted-foreground" />
            </div>
          ),
          title: 'No one here yet',
          description: 'Participants will appear once they join the meeting.',
        }}
        noResultsState={{
          title: 'No people found',
          description: "We couldn't find anyone matching your filter.",
        }}
      />

      {addPeopleDialogContent && (
        <Dialog open={showAddDialog} onOpenChange={setShowAddDialog}>
          <DialogContent className="sm:max-w-[480px]">
            {addPeopleDialogContent}
          </DialogContent>
        </Dialog>
      )}

      {menuRow && (
        <ParticipantContextMenu
          participant={menuRow.raw}
          isSelf={menuRow.isSelf}
          meeting={meeting}
          pinned={!!menuRow.raw?.pinned}
          position={menuPos}
          onClose={() => setMenuRow(null)}
          onClickDetails={onClickPerson}
          canManageParticipants={selfIsHost}
        />
      )}
    </div>
  );
}
