import type { ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';

export interface MemberSidebarRowProps {
  name: string;
  image?: string | null;
  /** The line under the name: the role on the timeline, the skills on capacity. */
  subtitle?: ReactNode;
  /** The figures on the right: the top line stands out, the bottom line is muted. */
  meta?: ReactNode;
  metaSecondary?: ReactNode;
  rowHeight: number;
  isExpanded: boolean;
  onToggle: () => void;
  /** The toggle's accessible name, when the row's text alone doesn't say what it opens. */
  toggleLabel?: string;
  /** A control at the end of the row, outside the toggle (capacity's edit button). */
  action?: ReactNode;
}

/**
 * A member in the member list of the workload views (timeline and capacity):
 * chevron, avatar, name and figures. Clicking the row opens what the member carries.
 */
export function MemberSidebarRow({
  name,
  image,
  subtitle,
  meta,
  metaSecondary,
  rowHeight,
  isExpanded,
  onToggle,
  toggleLabel,
  action,
}: Readonly<MemberSidebarRowProps>) {
  return (
    <div className="flex items-center border-b border-border/50 hover:bg-secondary/50" style={{ height: rowHeight }}>
      <button
        type="button"
        aria-expanded={isExpanded}
        aria-label={toggleLabel}
        onClick={onToggle}
        className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-3 px-3 text-left"
      >
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px] text-muted-foreground transition-colors hover:bg-black/5 dark:hover:bg-white/5">
          {isExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </span>
        <Avatar className="-ml-1 h-[30px] w-[30px]">
          {image ? <AvatarImage src={image} /> : null}
          <AvatarFallback className="text-xs">{(name || '?').slice(0, 2)}</AvatarFallback>
        </Avatar>
        <span className="-ml-1 block min-w-0 flex-1 -space-y-px">
          <span className="block truncate text-sm font-medium">{name}</span>
          {subtitle ? <span className="block truncate text-xs text-muted-foreground">{subtitle}</span> : null}
        </span>
        {meta || metaSecondary ? (
          <span className="block shrink-0 space-y-0.5 text-right">
            {meta ? <span className="block text-xs font-medium">{meta}</span> : null}
            {metaSecondary ? <span className="block text-xs text-muted-foreground">{metaSecondary}</span> : null}
          </span>
        ) : null}
      </button>
      {action ? <span className="shrink-0 pr-2">{action}</span> : null}
    </div>
  );
}
