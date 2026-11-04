import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { cn } from '@/lib/utils';
import { initialsOf } from '@/app/weldflow/project/[projectId]/raid/_lib/raid';

/** Initials (or the picture) of a person; decorative, the name is always written next to it. */
export function PersonAvatar({ name, avatar, className }: Readonly<{ name: string; avatar?: string | null; className?: string }>) {
  return (
    <Avatar aria-hidden className={cn('size-6 shrink-0', className)}>
      {avatar ? <AvatarImage src={avatar} alt="" /> : null}
      <AvatarFallback className="bg-muted text-[10px] font-semibold text-foreground/80">{initialsOf(name)}</AvatarFallback>
    </Avatar>
  );
}
