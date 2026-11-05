import type { BoardPeer } from '@weldsuite/board-engine';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { Button } from '@weldsuite/ui/components/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@weldsuite/ui/components/dropdown-menu';
import { useI18n } from '@/lib/i18n/provider';
import type { BoardController } from '../editor/model/board-controller';

const MAX_SHOWN = 5;

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? [parts[0]![0], parts.at(-1)![0]] : [parts[0]?.[0]];
  return letters.join('').toUpperCase() || '?';
}

/** The others on the board, one avatar per person; each one's menu goes to them or follows them. */
export function PeerAvatars({ controller: c, peers }: { controller: BoardController; peers: BoardPeer[] }) {
  const { t, format } = useI18n();
  const tp = t.weldboard.editor.peers;
  const people = [...new Map(peers.map((p) => [p.userId, p])).values()];
  if (people.length === 0) return null;
  const shown = people.slice(0, MAX_SHOWN);
  const more = people.length - shown.length;
  return (
    <div className="flex items-center -space-x-1.5" role="group">
      {shown.map((peer) => (
        <DropdownMenu key={peer.userId}>
          <DropdownMenuTrigger asChild>
            <button type="button" aria-label={peer.name} className="rounded-[32%]">
              <Avatar className="size-7 border-2 border-background" style={{ boxShadow: `0 0 0 2px ${peer.color}` }}>
                {peer.picture && <AvatarImage src={peer.picture} alt="" />}
                <AvatarFallback className="text-[10px] font-medium text-white" style={{ backgroundColor: peer.color }}>
                  {initials(peer.name)}
                </AvatarFallback>
              </Avatar>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>{peer.name}</DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => c.goToPeer(peer)}>{format(tp.goTo, { name: peer.name })}</DropdownMenuItem>
            {c.following === peer.clientId ? (
              <DropdownMenuItem onSelect={() => c.follow(null)}>{tp.stopFollowing}</DropdownMenuItem>
            ) : (
              <DropdownMenuItem onSelect={() => c.follow(peer.clientId)}>{tp.follow}</DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      ))}
      {more > 0 && (
        <Avatar className="size-7 ring-2 ring-background">
          <AvatarFallback className="bg-muted text-[10px] font-medium">{format(tp.others, { count: more })}</AvatarFallback>
        </Avatar>
      )}
    </div>
  );
}

/** A banner while someone is presenting or being followed. */
export function FollowBanner({ controller: c, peers }: { controller: BoardController; peers: BoardPeer[] }) {
  const { t, format } = useI18n();
  const tp = t.weldboard.editor.peers;
  const followed = c.following ? peers.find((p) => p.clientId === c.following) : undefined;
  const presenter = peers.find((p) => p.presence?.presenting);
  if (followed) {
    return (
      <div className="pointer-events-auto flex items-center gap-2 rounded-full px-3 py-1 text-sm text-white shadow" style={{ backgroundColor: followed.color }}>
        {format(tp.following, { name: followed.name })}
        <Button size="sm" variant="secondary" className="h-6 px-2 text-xs" onClick={() => c.follow(null)}>
          {tp.stopFollowing}
        </Button>
      </div>
    );
  }
  if (presenter && !c.presenting) {
    return (
      <div className="pointer-events-auto flex items-center gap-2 rounded-full border bg-background px-3 py-1 text-sm shadow">
        {format(tp.presenting, { name: presenter.name })}
        <Button size="sm" className="h-6 px-2 text-xs" onClick={() => c.follow(presenter.clientId)}>
          {tp.join}
        </Button>
      </div>
    );
  }
  return null;
}
