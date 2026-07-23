
import * as React from 'react';
import { useState } from 'react';
import { Check, CreditCard } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Button } from '@weldsuite/ui/components/button';
import { PricingDialog } from '@/components/pricing-dialog';
import { cn } from '@/lib/utils';

interface UpgradeBusinessFeaturesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type FeatureRow = {
  icon: string;
  iconClass?: string;
  label: string;
  sublabel?: string;
  free: React.ReactNode;
  upgrade: React.ReactNode;
};

const FEATURES: FeatureRow[] = [
  {
    icon: '/assets/images/weldsuite/icon.svg',
    iconClass: 'h-5 w-5',
    label: 'All business apps in one workspace',
    free: <CheckMark />,
    upgrade: <CheckMark highlight />,
  },
  {
    icon: '/assets/images/weldmail/logo-light.png',
    label: 'Custom email domain @your-company.com',
    free: null,
    upgrade: <CheckMark highlight />,
  },
  {
    icon: '/assets/images/weldagent/logo-light.png',
    label: 'WeldAgent AI assistant',
    free: null,
    upgrade: <CheckMark highlight />,
  },
  {
    icon: '/assets/images/weldmeet/logo-light.png',
    label: 'Appointment booking pages',
    free: null,
    upgrade: <CheckMark highlight />,
  },
  {
    icon: '/assets/images/weldcrm/logo-light.png',
    label: 'Unlimited contacts, deals, and sequences',
    free: null,
    upgrade: <CheckMark highlight />,
  },
  {
    icon: '/assets/images/welddesk/logo-light.png',
    label: 'Custom branding',
    free: null,
    upgrade: <CheckMark highlight />,
  },
  {
    icon: '/assets/images/weldflow/logo-light.png',
    label: 'Security and management controls',
    free: null,
    upgrade: <CheckMark highlight />,
  },
];

function CheckMark({ highlight = false }: { highlight?: boolean }) {
  return (
    <Check
      className={cn('h-5 w-5 mx-auto', highlight ? 'text-blue-600' : 'text-foreground')}
      strokeWidth={2.5}
    />
  );
}

export function UpgradeBusinessFeaturesDialog({
  open,
  onOpenChange,
}: UpgradeBusinessFeaturesDialogProps) {
  const [pricingOpen, setPricingOpen] = useState(false);

  const handleContinue = () => {
    onOpenChange(false);
    setPricingOpen(true);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="p-0 overflow-hidden sm:max-w-[540px] gap-0">
          <DialogTitle className="sr-only">Unlock business features</DialogTitle>

          {/* Brand bar */}
          <div className="flex items-center justify-center border-b px-6 py-4 bg-background">
            <img
              src="/assets/images/weldsuite/logo-horizontal-light.png"
              alt="WeldSuite"
              className="h-6 w-auto dark:hidden"
            />
            <img
              src="/assets/images/weldsuite/logo-horizontal-dark.png"
              alt="WeldSuite"
              className="h-6 w-auto hidden dark:block"
            />
          </div>

          {/* Title */}
          <div className="px-6 pt-8 pb-4 text-center">
            <h2 className="text-2xl font-normal text-foreground">Unlock business features</h2>
          </div>

          {/* Comparison table */}
          <div className="px-6 pb-4">
            <div className="relative">
              {/* Continuous blue background for the Upgrade column */}
              <div className="absolute top-0 bottom-0 right-0 w-[88px] bg-blue-50 dark:bg-blue-950/40 rounded-xl pointer-events-none" />

              {/* Column headers */}
              <div className="relative grid grid-cols-[1fr_80px_88px] items-center pt-3 pb-3 text-sm">
                <div />
                <div className="text-center font-semibold text-foreground">Free</div>
                <div className="text-center font-semibold text-blue-600">Upgrade</div>
              </div>

              {/* Rows */}
              <div className="relative border-t">
                {FEATURES.map((row, idx) => (
                  <div
                    key={idx}
                    className="grid grid-cols-[1fr_80px_88px] items-center border-b last:border-b-0 py-3"
                  >
                    <div className="flex items-start gap-3 pr-2">
                      <img
                        src={row.icon}
                        alt=""
                        className={cn('shrink-0 mt-0.5', row.iconClass ?? 'h-5 w-5')}
                      />
                      <div className="text-sm text-foreground leading-snug">
                        {row.label}
                        {row.sublabel && (
                          <div className="text-muted-foreground">{row.sublabel}</div>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center justify-center">{row.free}</div>
                    <div className="flex items-center justify-center">{row.upgrade}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between border-t px-6 py-4 bg-background">
            <div className="flex items-center gap-2 text-sm text-foreground">
              <CreditCard className="h-4 w-4" />
              <span className="font-medium">No cost for 14 days</span>
            </div>
            <Button onClick={handleContinue}>Continue</Button>
          </div>
        </DialogContent>
      </Dialog>

      <PricingDialog open={pricingOpen} onOpenChange={setPricingOpen} />
    </>
  );
}
