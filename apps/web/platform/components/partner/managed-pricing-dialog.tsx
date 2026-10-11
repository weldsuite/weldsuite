/**
 * What the "Upgrade" dialog shows in a partner-managed workspace: nothing to
 * buy, so it says who to contact instead of listing WeldSuite plans.
 */

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import type { PartnerPublicInfo } from '@weldsuite/app-api-client/schemas/partners';
import { useI18n } from '@/lib/i18n/provider';
import { PartnerContactLinks, PartnerLogo } from './partner-contact';

export function ManagedPricingDialog({
  open,
  onOpenChange,
  partner,
}: Readonly<{ open: boolean; onOpenChange: (open: boolean) => void; partner: PartnerPublicInfo }>) {
  const { t, format } = useI18n();
  const tm = t.partner.managed;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="mb-2 flex items-center gap-3">
            <PartnerLogo partner={partner} />
            <DialogTitle className="text-left">{format(tm.title, { partner: partner.name })}</DialogTitle>
          </div>
          <DialogDescription>{format(tm.needMore, { partner: partner.name })}</DialogDescription>
        </DialogHeader>
        <PartnerContactLinks partner={partner} />
      </DialogContent>
    </Dialog>
  );
}
