import { useState, useEffect, useCallback, type ReactNode } from 'react';
import { Search, Mic, MicOff, Video as VideoIcon, VideoOff, Check, Copy } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { cn } from '@weldsuite/ui/lib/utils';

// Same palette as ParticipantTile + AdmitGuestsPill so a guest's avatar color
// is identical in the side panel, the admission pill, and the in-call tile.
const PERSON_THEMES = [
  '#578a72', '#7a67a3', '#6788ad', '#a8707e', '#5d9494',
  '#a88a6c', '#7770ab', '#a26178', '#688a57', '#9c6857',
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
  return PERSON_THEMES[hashString(seed || 'guest') % PERSON_THEMES.length]!;
}

export interface PeoplePanelProps {
  meeting: any;
  participants: any[];
  /** When true, the leftmost participant tile shows "(Host)" suffix. */
  selfIsHost?: boolean;
  /**
   * When provided, clicking a participant row opens the host app's
   * details sheet (CRM contact / team member). Hover state surfaces.
   */
  onClickDetails?: (participant: any) => void;
  /** Meeting join code — when set, shows the code chip + copy button at the top. */
  joinCode?: string;
  /** Public share URL copied when the chip's copy button is clicked. */
  shareUrl?: string;
  /** Slot — host app's "+" invite popover trigger, rendered next to the chip. */
  invitePopoverSlot?: ReactNode;
}

export function PeoplePanel({
  meeting,
  participants,
  selfIsHost = true,
  onClickDetails,
  joinCode,
  shareUrl,
  invitePopoverSlot,
}: PeoplePanelProps) {
  const [waitlisted, setWaitlisted] = useState<any[]>([]);
  const [codeCopied, setCodeCopied] = useState(false);

  const handleCopyCode = async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCodeCopied(true);
      setTimeout(() => setCodeCopied(false), 2000);
    } catch { /* ignore */ }
  };

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

  return (
    <div className="py-4">
      {joinCode && (
        <div className="px-4 pb-4">
          <div className="flex items-center gap-[6px]">
            <div className="flex items-center gap-2 h-8 flex-1 rounded-md border bg-muted/50 pl-3 pr-1 pt-px">
              <span className="text-[13px] font-mono text-muted-foreground">{joinCode}</span>
              <button
                onClick={handleCopyCode}
                className="ml-auto shrink-0 p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                title="Copy meeting link"
              >
                {codeCopied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              </button>
            </div>
            {invitePopoverSlot}
          </div>
        </div>
      )}
      <div className="px-4 pb-6">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input placeholder="Search people..." className="h-[37px] text-xs pl-8" />
        </div>
      </div>

      {waitlisted.length > 0 && (
        <>
          <div className="px-5 pb-1">
            <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest">
              Waiting to join ({waitlisted.length})
            </p>
          </div>
          <div className="px-4">
            {waitlisted.map((p: any) => {
              const seed = String(p.customParticipantId ?? p.userId ?? p.id ?? p.name ?? '');
              return (
              <div key={p.id} className="flex items-center gap-3 py-2">
                <Avatar className="h-7 w-7 !rounded-[8px]">
                  {p.picture && <AvatarImage src={p.picture} className="!rounded-[8px]" />}
                  <AvatarFallback
                    className="text-[10px] font-medium !rounded-[8px] text-white"
                    style={{ backgroundColor: getAvatarColor(seed) }}
                  >
                    {getInitials(p.name ?? '?')}
                  </AvatarFallback>
                </Avatar>
                <span className="flex-1 text-[13px] font-medium truncate">{p.name ?? 'Guest'}</span>
                <div className="flex items-center gap-1.5">
                  <Button variant="outline" size="sm" className="text-muted-foreground" onClick={() => handleReject(p.id)}>
                    Deny
                  </Button>
                  <Button size="sm" onClick={() => handleAdmit(p.id)}>
                    Admit
                  </Button>
                </div>
              </div>
              );
            })}
            {waitlisted.length > 1 && (
              <Button variant="secondary" size="sm" className="w-full mt-1" onClick={handleAdmitAll}>
                Admit all ({waitlisted.length})
              </Button>
            )}
          </div>
          <div className="px-5 pt-3 pb-5"><div className="h-px bg-border" /></div>
        </>
      )}

      <div className="px-5 pb-1">
        <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest">In this call ({participants.length})</p>
      </div>
      <div className="px-4">
        {participants.map((p, i) => {
          const isSelf = i === 0;
          const initials = (p.name ?? '?').charAt(0).toUpperCase();
          const clickable = !!onClickDetails;
          return (
            <div
              key={p.id}
              className={cn(
                'flex items-center gap-3 py-2.5 px-1 -mx-1 rounded-md',
                clickable && 'cursor-pointer hover:bg-muted/50 transition-colors',
              )}
              onClick={clickable ? () => onClickDetails!(p) : undefined}
              role={clickable ? 'button' : undefined}
              tabIndex={clickable ? 0 : undefined}
              onKeyDown={clickable ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onClickDetails!(p);
                }
              } : undefined}
            >
              <div className="relative">
                <Avatar className="h-7 w-7 !rounded-[8px]">
                  {p.picture && <AvatarImage src={p.picture} className="!rounded-[8px]" />}
                  <AvatarFallback className="text-[10px] font-medium !rounded-[8px]">{initials}</AvatarFallback>
                </Avatar>
                <div className={cn(
                  'absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-background',
                  p.audioEnabled && p.videoEnabled ? 'bg-emerald-500' : 'bg-muted-foreground/40',
                )} />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[13px] font-medium leading-tight truncate">
                  {isSelf ? 'You' : p.name ?? 'Participant'}
                  {isSelf && selfIsHost && <span className="text-muted-foreground font-normal"> (Host)</span>}
                </p>
              </div>
              <div className="flex items-center gap-1">
                <div className={cn('flex h-7 w-7 items-center justify-center rounded-[8px]', p.audioEnabled ? 'bg-muted text-muted-foreground' : 'bg-red-500/10 text-red-400')}>
                  {p.audioEnabled ? <Mic className="h-3.5 w-3.5" /> : <MicOff className="h-3.5 w-3.5" />}
                </div>
                <div className={cn('flex h-7 w-7 items-center justify-center rounded-[8px]', p.videoEnabled ? 'bg-muted text-muted-foreground' : 'bg-red-500/10 text-red-400')}>
                  {p.videoEnabled ? <VideoIcon className="h-3.5 w-3.5" /> : <VideoOff className="h-3.5 w-3.5" />}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
