import type { Peer } from '@weldsuite/sheets-engine';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@weldsuite/ui/components/tooltip';
import { useI18n } from '@/lib/i18n/provider';

const MAX_SHOWN = 5;

/** The other people in the sheet, one avatar per person (several tabs count once). Clicking one goes to where they are. */
export function PeerAvatars({ peers, onSelect }: { peers: Peer[]; onSelect: (peer: Peer) => void }) {
  const { t, format } = useI18n();
  const te = t.weldsheets.editor;
  const people = [...new Map(peers.map((p) => [p.userId, p])).values()];
  if (people.length === 0) return null;
  const shown = people.slice(0, MAX_SHOWN);
  const more = people.length - shown.length;

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex items-center -space-x-1.5" role="group" aria-label={te.collaborators}>
        {shown.map((peer) => {
          const label = peer.canEdit ? peer.name : format(te.viewing, { name: peer.name });
          return (
            <Tooltip key={peer.userId}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => onSelect(peer)}
                  aria-label={label}
                  className="rounded-full border-2 border-background"
                  style={{ boxShadow: `0 0 0 2px ${peer.color}` }}
                >
                  <Avatar className="size-6">
                    {peer.picture && <AvatarImage src={peer.picture} alt="" />}
                    <AvatarFallback className="text-[10px] font-medium text-white" style={{ backgroundColor: peer.color }}>
                      {initials(peer.name)}
                    </AvatarFallback>
                  </Avatar>
                </button>
              </TooltipTrigger>
              <TooltipContent>{label}</TooltipContent>
            </Tooltip>
          );
        })}
        {more > 0 && (
          <span className="flex size-6 items-center justify-center rounded-full bg-muted text-[10px] font-medium ring-2 ring-background">
            +{more}
          </span>
        )}
      </div>
    </TooltipProvider>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? [parts[0]![0], parts.at(-1)![0]] : [parts[0]?.[0]];
  return letters.join('').toUpperCase() || '?';
}
