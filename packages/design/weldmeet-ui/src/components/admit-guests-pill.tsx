import { useCallback, useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardFooter } from '@weldsuite/ui/components/card';
import { Separator } from '@weldsuite/ui/components/separator';
import { getInitials } from '../lib/person-theme';
import { PersonAvatar } from './person-avatar';
import type { MeetingClient, WaitlistedPeer } from '../types';

export interface AdmitGuestsPillProps {
  meeting: MeetingClient | null;
}

/**
 * Lobby notification popup.
 *
 * Floats over the top-right of the meeting view as soon as someone is in the
 * waiting room and shows their avatar, name, and inline `Admit` / `Deny entry`
 * actions. Returns null when no one is waiting.
 */
export function AdmitGuestsPill({ meeting }: Readonly<AdmitGuestsPillProps>) {
  const [waitlisted, setWaitlisted] = useState<WaitlistedPeer[]>([]);
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!meeting?.participants?.waitlisted) return;
    const update = () => {
      const list = meeting.participants.waitlisted.toArray?.() ?? [];
      setWaitlisted([...list]);
    };
    update();
    meeting.participants.waitlisted.on?.('participantJoined', update);
    meeting.participants.waitlisted.on?.('participantLeft', update);
    const pollInterval = setInterval(update, 2000);
    return () => {
      clearInterval(pollInterval);
      meeting.participants.waitlisted.off?.('participantJoined', update);
      meeting.participants.waitlisted.off?.('participantLeft', update);
    };
  }, [meeting]);

  // Drop dismissed ids that are no longer in the queue.
  useEffect(() => {
    setDismissedIds((prev) => {
      const liveIds = new Set(waitlisted.map((p) => p.id));
      const next = new Set<string>();
      for (const id of prev) if (liveIds.has(id)) next.add(id);
      return next.size === prev.size ? prev : next;
    });
  }, [waitlisted]);

  const handleAdmit = useCallback(
    (id: string) => {
      try {
        meeting?.participants?.acceptWaitingRoomRequest(id);
      } catch {
        /* ignore */
      }
    },
    [meeting],
  );

  const handleReject = useCallback(
    async (id: string) => {
      try {
        await meeting?.participants?.rejectWaitingRoomRequest(id);
      } catch {
        /* ignore */
      }
    },
    [meeting],
  );

  const handleAdmitAll = useCallback(async () => {
    const ids = waitlisted.map((p) => p.id);
    try {
      await meeting?.participants?.acceptAllWaitingRoomRequest(ids);
    } catch {
      /* ignore */
    }
  }, [meeting, waitlisted]);

  const visible = waitlisted.filter((p) => !dismissedIds.has(p.id));
  const primary = visible[0];
  if (!primary) return null;

  const extraCount = visible.length - 1;
  const primaryName = primary.name ?? 'Guest';
  const initials = getInitials(primaryName);
  const colorSeed = String(
    primary.customParticipantId ?? primary.userId ?? primary.id ?? primaryName,
  );

  return (
    <Card
      role="dialog"
      aria-label="Lobby notification"
      className="absolute top-4 right-4 z-30 w-[340px] max-md:top-2 max-md:right-2 max-md:w-auto max-md:left-2 gap-0 py-0 shadow-lg animate-in fade-in slide-in-from-top-2 duration-200"
    >
      <Button
        variant="ghost"
        size="icon"
        aria-label="Dismiss"
        onClick={() => setDismissedIds((prev) => new Set(prev).add(primary.id))}
        className="absolute top-1.5 right-1.5 size-7 text-muted-foreground"
      >
        <X className="size-3.5" />
      </Button>

      <CardContent className="flex items-start gap-3 px-4 pt-4 pb-3 pr-10">
        <PersonAvatar
          initials={initials}
          picture={primary.picture}
          colorSeed={colorSeed}
          className="h-9 w-9 !rounded-[10px] shrink-0"
          innerClassName="text-[13px] !rounded-[10px]"
        />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold leading-none truncate">
            {primaryName}
          </p>
          <p className="text-xs text-muted-foreground mt-1.5">
            is waiting in the lobby
          </p>
        </div>
      </CardContent>

      <CardFooter className="gap-2 px-4 pb-4">
        <Button
          variant="outline"
          size="sm"
          className="flex-1"
          onClick={() => handleReject(primary.id)}
        >
          Deny entry
        </Button>
        <Button
          size="sm"
          className="flex-1"
          onClick={() => handleAdmit(primary.id)}
        >
          Admit
        </Button>
      </CardFooter>

      {extraCount > 0 && (
        <>
          <Separator />
          <CardFooter className="justify-between gap-2 px-4 py-2.5 bg-muted/40 rounded-b-lg">
            <p className="text-xs text-muted-foreground">
              +{extraCount} {extraCount === 1 ? 'other person' : 'others'} waiting
            </p>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2"
              onClick={handleAdmitAll}
            >
              Admit all
            </Button>
          </CardFooter>
        </>
      )}
    </Card>
  );
}
