import { PricingTable } from '@clerk/clerk-react';

export function PricingPage() {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-[53px] shrink-0 items-center border-b border-border px-4">
        <h1 className="text-sm font-semibold text-foreground">Plans</h1>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-3xl rounded-xl border border-border bg-card p-6 shadow-sm">
          <h2 className="mb-1 text-lg font-semibold text-card-foreground">Plans</h2>
          <p className="mb-6 text-sm text-muted-foreground">
            Free is the default. Upgrade to Pro for higher send limits.
          </p>
          <PricingTable for="user" />
        </div>
      </div>
    </div>
  );
}
