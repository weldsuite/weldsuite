
import * as React from 'react';
import { useState } from 'react';
import { Check, CreditCard, Minus } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Button } from '@weldsuite/ui/components/button';
import { PricingDialog } from '@/components/pricing-dialog';
import { useI18n } from '@/lib/i18n/provider';

interface UpgradeBusinessFeaturesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type FeatureKey =
  | 'allApps'
  | 'customEmailDomain'
  | 'weldAgent'
  | 'bookingPages'
  | 'unlimitedCrm'
  | 'customBranding'
  | 'securityControls';

type FeatureRow = {
  icon: string;
  /** Key of the label in `common.upgradeBusinessFeatures.features`. */
  key: FeatureKey;
  sublabel?: string;
  free: boolean;
};

const FEATURES: FeatureRow[] = [
  { icon: '/assets/images/weldsuite/icon.svg', key: 'allApps', free: true },
  { icon: '/assets/images/weldmail/icon.svg', key: 'customEmailDomain', free: false },
  { icon: '/assets/images/weldagent/icon.svg', key: 'weldAgent', free: false },
  { icon: '/assets/images/weldmeet/icon.svg', key: 'bookingPages', free: false },
  { icon: '/assets/images/weldcrm/icon.svg', key: 'unlimitedCrm', free: false },
  { icon: '/assets/images/welddesk/icon.svg', key: 'customBranding', free: false },
  { icon: '/assets/images/weldpass/icon.svg', key: 'securityControls', free: false },
];

const COLUMNS = 'grid grid-cols-[1fr_64px_88px] items-center';

export function UpgradeBusinessFeaturesDialog({
  open,
  onOpenChange,
}: Readonly<UpgradeBusinessFeaturesDialogProps>) {
  const { t } = useI18n();
  const tu = t.common.upgradeBusinessFeatures;
  const [pricingOpen, setPricingOpen] = useState(false);

  const handleContinue = () => {
    onOpenChange(false);
    setPricingOpen(true);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          showCloseButton={false}
          className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[560px]"
        >
          {/* Hero */}
          <div className="relative shrink-0 px-8 pt-9 pb-8 text-center">
            {/* Soft glow spilling in from above the top edge */}
            <div
              aria-hidden
              className="pointer-events-none absolute -top-28 left-1/2 h-52 w-[440px] max-w-full -translate-x-1/2 rounded-full bg-blue-500/15 blur-3xl dark:bg-blue-500/20"
            />
            <div className="relative">
              {/* Icon and wordmark are separate so the icon can sit closer to the text height */}
              <div className="mb-6 flex items-center justify-center gap-2">
                <img src="/assets/images/weldsuite/icon.svg" alt="" className="h-[22px] w-[22px]" />
                <img
                  src="/assets/images/weldsuite/wordmark-light.svg"
                  alt="WeldSuite"
                  className="h-4 w-auto dark:hidden"
                />
                <img
                  src="/assets/images/weldsuite/wordmark-dark.svg"
                  alt="WeldSuite"
                  className="hidden h-4 w-auto dark:block"
                />
              </div>
              <DialogTitle className="text-2xl leading-tight font-semibold tracking-tight">
                {tu.title}
              </DialogTitle>
              <DialogDescription className="mt-1.5">
                {tu.description}
              </DialogDescription>
            </div>
          </div>

          {/* Comparison table */}
          <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-5">
            <div className="relative">
              {/* Continuous tint behind the Upgrade column */}
              <div className="pointer-events-none absolute inset-y-0 right-0 w-[88px] rounded-lg bg-blue-500/5 dark:bg-blue-400/5" />

              {/* Column headers */}
              <div className={`relative ${COLUMNS} py-2.5 text-sm font-medium`}>
                <div />
                <div className="text-center text-muted-foreground">{tu.free}</div>
                <div className="text-center text-blue-600 dark:text-blue-400">{t.common.actions.upgrade}</div>
              </div>

              {/* Rows */}
              <div className="relative border-t">
                {FEATURES.map((row) => (
                  <div key={row.key} className={`${COLUMNS} border-b py-2.5 last:border-b-0`}>
                    <div className="flex items-center gap-3 pr-3">
                      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted">
                        <img src={row.icon} alt="" className="h-4 w-4 object-contain" />
                      </div>
                      <div className="text-sm leading-snug text-foreground">
                        {tu.features[row.key]}
                        {row.sublabel && (
                          <div className="text-muted-foreground">{row.sublabel}</div>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center justify-center">
                      {row.free ? (
                        <Check className="h-4 w-4 text-foreground" />
                      ) : (
                        <Minus className="h-4 w-4 text-muted-foreground/40" />
                      )}
                    </div>
                    <div className="flex items-center justify-center">
                      <Check className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="flex shrink-0 items-center justify-between gap-3 border-t bg-muted/40 px-6 py-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <CreditCard className="h-4 w-4" />
              <span>{tu.cancelAnytime}</span>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {tu.maybeLater}
              </Button>
              <Button onClick={handleContinue}>{tu.seePlans}</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <PricingDialog open={pricingOpen} onOpenChange={setPricingOpen} />
    </>
  );
}
