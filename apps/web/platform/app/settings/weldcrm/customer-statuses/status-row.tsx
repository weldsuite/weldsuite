import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { EllipsisVertical, Pencil, Trash2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { cn } from '@/lib/utils';
import type { CustomerStatus } from '@weldsuite/core-api-client/schemas/customer-statuses';
import { STATUS_STYLE_MAP } from '@/hooks/queries/use-weldcrm-customer-statuses';
import { getTranslations } from '@/lib/i18n';

const PILL_BASE =
  'inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none';

interface StatusRowProps {
  status: CustomerStatus;
  isLast: boolean;
  onEdit: (status: CustomerStatus) => void;
  onDelete: (status: CustomerStatus) => void;
}

export function StatusRow({ status, isLast, onEdit, onDelete }: StatusRowProps) {
  const ts = getTranslations('settings');
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: status.id,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <tr
      ref={setNodeRef}
      style={style}
      className={cn(
        'group bg-white dark:bg-background hover:bg-muted/50 transition-colors cursor-grab active:cursor-grabbing touch-none',
        !isLast && 'border-b'
      )}
      {...attributes}
      {...listeners}
    >
      <td className="h-[42px] px-3 align-middle">
        <span
          className={cn(
            PILL_BASE,
            (STATUS_STYLE_MAP[status.color] ?? STATUS_STYLE_MAP.gray).color,
            (STATUS_STYLE_MAP[status.color] ?? STATUS_STYLE_MAP.gray).bg
          )}
        >
          {status.name}
        </span>
      </td>
      <td className="h-[42px] px-3 align-middle text-xs text-muted-foreground font-mono">
        {status.slug}
      </td>
      <td className="h-[42px] px-3 align-middle">
        <span className={cn(PILL_BASE, 'border border-border text-muted-foreground')}>
          {ts.weldcrm.customBadge}
        </span>
      </td>
      <td
        className="h-[42px] px-3 align-middle text-right cursor-default"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100 transition-opacity"
            >
              <EllipsisVertical className="h-4 w-4" />
              <span className="sr-only">{ts.weldcrm.customerStatuses.openMenu}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => onEdit(status)}>
              <Pencil className="h-4 w-4" />
              {ts.weldcrm.customerStatuses.menuEdit}
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onClick={() => onDelete(status)}>
              <Trash2 className="h-4 w-4" />
              {ts.weldcrm.customerStatuses.menuDelete}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </td>
    </tr>
  );
}
