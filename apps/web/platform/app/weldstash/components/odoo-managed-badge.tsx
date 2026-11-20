import { Factory } from 'lucide-react';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { getTranslations } from '@/lib/i18n';

/**
 * Marks a warehouse (or a row in one) whose stock is managed in Odoo: it was
 * synced from an Odoo connection (`managedByConnectionId`), so Odoo is the
 * master and WeldStash shows its stock read-only.
 */
export function OdooManagedBadge({ className }: Readonly<{ className?: string }>) {
  const t = getTranslations('weldstashPurchasing');
  return (
    <SoftBadge tone="neutral" className={className} title={t.odoo.managedHint}>
      <Factory className="mr-1 size-3" aria-hidden />
      {t.odoo.managedBadge}
    </SoftBadge>
  );
}
