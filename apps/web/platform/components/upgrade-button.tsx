
import * as React from 'react';
import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@weldsuite/ui/components/tooltip';
import { Button } from '@weldsuite/ui/components/button';
import { UpgradeBusinessFeaturesDialog } from './upgrade-business-features-dialog';

interface UpgradeButtonProps {
  collapsed?: boolean;
}

export function UpgradeButton({ collapsed = false }: UpgradeButtonProps) {
  const [open, setOpen] = useState(false);

  if (collapsed) {
    return (
      <div className="mb-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="icon"
              onClick={() => setOpen(true)}
              className="flex h-8 w-8 items-center justify-center rounded-md border border-blue-100 bg-blue-50 text-blue-600 hover:bg-blue-100 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-400 dark:hover:bg-blue-950/60 transition-colors"
            >
              <Sparkles className="h-4 w-4" />
              <span className="sr-only">Upgrade</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">Upgrade</TooltipContent>
        </Tooltip>
        <UpgradeBusinessFeaturesDialog open={open} onOpenChange={setOpen} />
      </div>
    );
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        className="flex w-full items-center justify-center rounded-md border border-blue-100 bg-blue-50 px-3 py-[7px] mb-2 text-sm font-medium text-blue-600 hover:bg-blue-100 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-400 dark:hover:bg-blue-950/60 transition-colors"
      >
        <span>Upgrade</span>
      </Button>
      <UpgradeBusinessFeaturesDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
