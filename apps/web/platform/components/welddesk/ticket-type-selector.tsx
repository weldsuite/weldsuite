import {
  Bug,
  ClipboardList,
  FileText,
  Loader2,
  Radar,
  RotateCcw,
  Star,
  Ticket,
  type LucideIcon,
} from 'lucide-react';
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from '@weldsuite/ui/components/command';
import { useTranslations } from '@weldsuite/i18n/client';
import {
  useTicketTypes,
  type TicketTypeConfig,
} from '@/hooks/queries/use-helpdesk-queries';

// ============================================================================
// Icon mapping
// ============================================================================

const ICON_MAP: Record<string, LucideIcon> = {
  Bug,
  RotateCcw,
  Star,
  ClipboardList,
  Radar,
  FileText,
  Ticket,
};

const CATEGORY_DEFAULT_ICONS: Record<string, LucideIcon> = {
  customer: Ticket,
  'back-office': ClipboardList,
  tracker: Radar,
};

function getIconForType(type: TicketTypeConfig): LucideIcon {
  if (type.icon && ICON_MAP[type.icon]) return ICON_MAP[type.icon];
  return CATEGORY_DEFAULT_ICONS[type.category || 'customer'] || FileText;
}

// ============================================================================
// Component
// ============================================================================

interface TicketTypeSelectorInlineProps {
  onSelect: (type: TicketTypeConfig) => void;
}

/** Inline version — renders Command content without its own Dialog */
export function TicketTypeSelectorInline({ onSelect }: TicketTypeSelectorInlineProps) {
  const t = useTranslations();
  const { data: ticketTypes, isLoading } = useTicketTypes();
  const activeTypes = (ticketTypes || []).filter((t) => t.isActive);

  const grouped = activeTypes.reduce<Record<string, TicketTypeConfig[]>>((acc, type) => {
    const cat = type.category || 'customer';
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(type);
    return acc;
  }, {});

  const categoryOrder = ['customer', 'back-office', 'tracker'];
  const categoryLabels: Record<string, string> = {
    customer: t('sweep.welddesk.ticketTypeSelector.categoryCustomer'),
    'back-office': t('sweep.welddesk.ticketTypeSelector.categoryBackOffice'),
    tracker: t('sweep.welddesk.ticketTypeSelector.categoryTracker'),
  };

  return (
    <Command className="[&_[cmdk-group-heading]]:text-muted-foreground **:data-[slot=command-input-wrapper]:h-12 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group]]:px-2 [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-2.5 [&_[cmdk-item]_svg]:h-5 [&_[cmdk-item]_svg]:w-5">
      <CommandInput placeholder={t('sweep.welddesk.ticketTypeSelector.searchPlaceholder')} />
      <CommandList>
        {isLoading ? (
          <div className="flex items-center justify-center gap-2 py-6">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            <span className="text-sm text-muted-foreground">{t('sweep.welddesk.ticketTypeSelector.loading')}</span>
          </div>
        ) : (
          <>
            <CommandEmpty>{t('sweep.welddesk.ticketTypeSelector.noTypesFound')}</CommandEmpty>
            {categoryOrder.map((cat) => {
              const types = grouped[cat];
              if (!types || types.length === 0) return null;
              return (
                <CommandGroup key={cat} heading={categoryLabels[cat] || cat}>
                  {types.map((type) => {
                    const Icon = getIconForType(type);
                    return (
                      <CommandItem
                        key={type.id}
                        onSelect={() => onSelect(type)}
                      >
                        <Icon />
                        <span>{type.name}</span>
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              );
            })}
          </>
        )}
      </CommandList>
    </Command>
  );
}

