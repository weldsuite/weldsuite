import { useCallback, useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardFooter } from '@weldsuite/ui/components/card';
import { Separator } from '@weldsuite/ui/components/separator';

// Same palette as ParticipantTile so the in-call tile and the admit pill
// resolve to the exact same color for a given guest. The lighter `avatar`
// shade is used because the pill avatar is small and circle-on-card needs
// to stay legible against a light/dark background.
const PERSON_THEMES = [
  { tile: '#3f6e58', avatar: '#578a72' },
  { tile: '#5e4d83', avatar: '#7a67a3' },
  { tile: '#4d6c8f', avatar: '#6788ad' },
  { tile: '#8a5060', avatar: '#a8707e' },
  { tile: '#3f7878', avatar: '#5d9494' },
  { tile: '#8a7050', avatar: '#a88a6c' },
  { tile: '#5b5694', avatar: '#7770ab' },
  { tile: '#874660', avatar: '#a26178' },
  { tile: '#4a6e3f', avatar: '#688a57' },
  { tile: '#7a4a3f', avatar: '#9c6857' },
] as const;

function hashString(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) - h) + input.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.charAt(0).toUpperCase();
  return (parts[0]!.charAt(0) + parts[parts.length - 1]!.charAt(0)).toUpperCase();
}

function getAvatarColor(seed: string): string {
  return PERSON_THEMES[hashString(seed || 'guest') % PERSON_THEMES.length]!.avatar;
}

export interface AdmitGuestsPillProps {
  meeting: any;
}

/**
 * Lobby notification popup.
 *
 * Floats over the top-right of the meeting view as soon as someone is in the
 * waiting room and shows their avatar, name, and inline `Admit` / `Deny entry`
 * actions. Returns null when no one is waiting.
 */
export function AdmitGuestsPill({ meeting }: AdmitGuestsPillProps) {
  const [waitlisted, setWaitlisted] = useState<any[]>([]);
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
      const liveIds = new Set(waitlisted.map((p: any) => p.id));
      const next = new Set<string>();
      for (const id of prev) if (liveIds.has(id)) next.add(id);
      return next.size === prev.size ? prev : next;
    });
  }, [waitlisted]);

  const handleAdmit = useCallback(
    async (id: string) => {
      try {
        await meeting?.participants?.acceptWaitingRoomRequest(id);
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
    const ids = waitlisted.map((p: any) => p.id);
    try {
      await meeting?.participants?.acceptAllWaitingRoomRequest(ids);
    } catch {
      /* ignore */
    }
  }, [meeting, waitlisted]);

  const visible = waitlisted.filter((p: any) => !dismissedIds.has(p.id));
  if (visible.length === 0) return null;

  const primary = visible[0];
  const extraCount = visible.length - 1;
  const primaryName = primary.name ?? 'Guest';
  const initials = getInitials(primaryName);
  const colorSeed = String(
    primary.customParticipantId ?? primary.userId ?? primary.id ?? primaryName,
  );
  const fallbackColor = getAvatarColor(colorSeed);

  return (
    <Card
      role="dialog"
      aria-label="Lobby notification"
      className="absolute top-4 right-4 z-30 w-[340px] gap-0 py-0 shadow-lg animate-in fade-in slide-in-from-top-2 duration-200"
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
        <Avatar className="h-9 w-9 !rounded-[10px] shrink-0">
          {primary.picture && (
            <AvatarImage src={primary.picture} className="!rounded-[10px]" />
          )}
          <AvatarFallback
            className="text-[13px] font-medium !rounded-[10px] text-white"
            style={{ backgroundColor: fallbackColor }}
          >
            {initials}
          </AvatarFallback>
        </Avatar>
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
