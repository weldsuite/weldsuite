
import * as React from 'react';
import { useState, useEffect } from 'react';
import { Coins } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import * as ProgressPrimitive from "@radix-ui/react-progress";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@weldsuite/ui/components/tooltip';
import { useCreditsBalance } from '@/hooks/queries/use-billing-queries';
import { useAppApiClient } from '@/lib/api/use-app-api';
import type { Credits } from '@/lib/api/types/apps/credits.types';
import { cn } from '@/lib/utils';
import { PricingDialog } from '@/components/pricing-dialog';
import { Link } from '@/lib/router';

interface ResourceUsageProps {
  collapsed?: boolean;
}

function UsageProgressBar({ value, thresholds, className }: {
  value: number;
  thresholds?: { red: number; amber: number };
  className?: string;
}) {
  const { red = 90, amber = 75 } = thresholds ?? {};

  const getIndicatorColor = (percentage: number) => {
    if (percentage >= red) return 'bg-red-500';
    if (percentage >= amber) return 'bg-amber-500';
    return 'bg-primary';
  };

  return (
    <ProgressPrimitive.Root
      className={cn(
        "bg-secondary relative h-1.5 w-full overflow-hidden rounded-full",
        className
      )}
    >
      <ProgressPrimitive.Indicator
        className={cn("h-full w-full flex-1 transition-all", getIndicatorColor(value))}
        style={{ transform: `translateX(-${100 - (value || 0)}%)` }}
      />
    </ProgressPrimitive.Root>
  );
}

export function ResourceUsage({ collapsed = false }: ResourceUsageProps) {
  const [isLoading, setIsLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);
  const [pricingOpen, setPricingOpen] = useState(false);
  const { getClient } = useAppApiClient();

  const { data: creditsResponse } = useCreditsBalance();
  const creditsData = (creditsResponse?.data as Credits.Balance) ?? null;

  useEffect(() => {
    async function checkRole() {
      try {
        const client = await getClient();
        // app-api GET /api/my-role (was api-worker GET /settings/my-role, which
        // returned the flags at the top level rather than under `data`).
        const roleResult = await client.get<{
          data: { role: string | null; canManageMembers: boolean; canManageRoles: boolean };
        }>('/my-role');
        setIsAdmin(roleResult.data.canManageMembers);
      } catch (error) {
        console.error('Error fetching workspace role:', error);
      } finally {
        setIsLoading(false);
      }
    }
    checkRole();
  }, [getClient]);

  const handlePlanChanged = React.useCallback(() => {
    // Credits data will auto-refresh via React Query
  }, []);

  if (isLoading || !isAdmin) {
    return null;
  }

  const showCredits = creditsData && creditsData.usagePercentage >= 80;

  if (!showCredits) {
    return null;
  }

  if (collapsed) {
    return (
      <>
        <div className="mb-2 px-0.5 flex flex-col gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground">
                <Coins className="h-4 w-4" />
              </div>
            </TooltipTrigger>
            <TooltipContent side="right" className="flex flex-col gap-2 py-2">
              <div className="flex flex-col gap-1.5">
                <span className="font-medium">Credits</span>
                <UsageProgressBar value={creditsData.usagePercentage} thresholds={{ red: 90, amber: 80 }} className="w-28" />
                <span className="text-xs">{creditsData.currentBalance} of {creditsData.monthlyAllocation} remaining</span>
              </div>
              <Button size="sm" className="mt-1 w-full" onClick={() => setPricingOpen(true)}>
                Upgrade
              </Button>
            </TooltipContent>
          </Tooltip>
        </div>
        <PricingDialog open={pricingOpen} onOpenChange={setPricingOpen} onPlanChanged={handlePlanChanged} />
      </>
    );
  }

  return (
    <div className="mb-2">
      <div>
        <div className="flex items-center justify-between mb-1.5 px-1">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Coins className="h-3.5 w-3.5" />
            <Link href="/settings/billing" className="hover:text-foreground transition-colors">Credits</Link>
          </div>
          <span className="text-xs text-muted-foreground">
            {creditsData.usagePercentage}%
          </span>
        </div>
        <div className="px-1">
          <UsageProgressBar value={creditsData.usagePercentage} thresholds={{ red: 90, amber: 80 }} />
          <div className="mt-1 text-xs text-muted-foreground">
            {creditsData.currentBalance} of {creditsData.monthlyAllocation} remaining
          </div>
        </div>
      </div>

      <Button size="sm" className="mt-2.5 w-full h-9" onClick={() => setPricingOpen(true)}>
        Upgrade
      </Button>
      <PricingDialog open={pricingOpen} onOpenChange={setPricingOpen} onPlanChanged={handlePlanChanged} />
    </div>
  );
}
