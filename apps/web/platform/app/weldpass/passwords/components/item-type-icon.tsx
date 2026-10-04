import { CreditCard, Globe, StickyNote } from 'lucide-react';
import type { WeldPassItemType } from '@weldsuite/app-api-client/domains/weldpass-passwords';
import { cn } from '@/lib/utils';

const ICONS = {
  login: Globe,
  note: StickyNote,
  card: CreditCard,
} satisfies Record<WeldPassItemType, typeof Globe>;

export function ItemTypeIcon({
  type,
  className,
}: Readonly<{ type: WeldPassItemType; className?: string }>) {
  const Icon = ICONS[type];
  return <Icon className={cn('h-4 w-4', className)} aria-hidden />;
}
